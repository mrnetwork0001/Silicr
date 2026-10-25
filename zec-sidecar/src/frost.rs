//! FROST 2-of-3 custody for provider bonds (ARCHITECTURE.md §5, docs/BONDS.md).
//!
//! The bond address is an Orchard-receiver-only unified address whose spend authorizing key `ak`
//! is a FROST(Pallas, BLAKE2b-512) group key shared by three parties (provider = 1, buyer pool = 2,
//! arbiter = 3) with threshold two. No party ever holds the spend authorizing key `ask`. The other
//! two components of the Orchard full viewing key (`nk`, `rivk`) are derived from `ak` with a
//! domain-separated PRF, so every participant computes the same FVK without another round. The
//! FVK is public by design (buyers verify the bond balance with it) and can never spend.
//!
//! Spending: a watch-only wallet opened from that FVK proposes the transaction and turns it into a
//! PCZT (`zcash_client_backend::create_pczt_from_proposal`), proves it, and the signers produce the
//! Ironwood spend-auth signatures with re-randomized FROST, the randomizer being each action's
//! `alpha`. The result is an ordinary RedPallas signature under `rk = ak + [alpha] G`, applied
//! through the PCZT low-level Signer role, so the chain sees a normal Ironwood transaction.
//! Ironwood (NU6.3) kept RedPallas spend authorization unchanged; only the circuit and the note
//! plaintext version differ, and the PCZT roles handle both.
//!
//! FROST comes from the Zcash Foundation's `reddsa` 0.5.2 (`frost::redpallas`, over frost-core 3.0
//! and frost-rerandomized 3.0). orchard 0.16 pins reddsa 0.6, which dropped the FROST module, so
//! both reddsa versions are linked and bridged through byte encodings (32-byte keys and scalars,
//! 64-byte signatures). Every round function here is stateless and works on serialized packages,
//! so the same code serves the in-process demo (`dkg-local`, `spend`) and the networked flow
//! where each party runs its own sidecar.

use std::{collections::BTreeMap, convert::Infallible, fs, path::Path, time::Instant};

use anyhow::{Context, anyhow, bail};
use ff::{FromUniformBytes, PrimeField};
use orchard::{
    circuit::OrchardCircuitVersion,
    keys::{FullViewingKey, Scope, SpendValidatingKey},
    primitives::redpallas,
};
use pczt::roles::{low_level_signer, prover::Prover, signer::Signer};
use reddsa_frost::frost::redpallas as frost;
use serde::{Deserialize, Serialize};
use tracing::info;
use zcash_client_backend::{
    data_api::{Account, WalletRead, wallet::{create_pczt_from_proposal, extract_and_store_transaction_from_pczt}},
    wallet::OvkPolicy,
};
use zcash_client_sqlite::{ReceivedNoteId, util::SystemClock};
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_primitives::transaction::builder::{BundlePadding, cached_orchard_proving_key};
use zcash_protocol::consensus::Network;

use frost::{
    Identifier, SigningPackage,
    keys::{EvenY, KeyPackage, PublicKeyPackage, dkg},
    rerandomized::{RandomizedParams, Randomizer},
    round1, round2,
};

use crate::{
    addr::encode_orchard,
    remote::chain_name,
    wallet::{OutputReq, SendReport, Wallet, WalletError, os_rng},
};

/// Signatures needed to move the bond.
pub const MIN_SIGNERS: u16 = 2;
/// Parties holding a share.
pub const MAX_SIGNERS: u16 = 3;
/// FROST identifiers 1..=3 map to these roles.
pub const ROLES: [&str; 3] = ["provider", "buyer-pool", "arbiter"];
/// BLAKE2b personalization for the FVK components derived from `ak`.
const FVK_PERSONAL: &[u8; 16] = b"Silicr_FROSTbond";

/// One party's share, kept private (mode 0600). `keyPackage` holds the signing share.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShareFile {
    pub version: u32,
    pub network: String,
    pub role: String,
    pub identifier: u16,
    /// frost-core `KeyPackage`, postcard, hex. Secret.
    pub key_package: String,
    /// frost-core `PublicKeyPackage`, postcard, hex.
    pub public_key_package: String,
}

/// The public description of a bond key: what the directory entry carries and what buyers verify.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GroupFile {
    pub version: u32,
    pub network: String,
    pub threshold: u16,
    pub participants: u16,
    /// frost-core `PublicKeyPackage`, postcard, hex (group key plus every verifying share).
    pub public_key_package: String,
    /// The group verifying key = Orchard spend validating key `ak`, hex (even y).
    pub ak: String,
    /// Orchard raw full viewing key (ak || nk || rivk), hex.
    pub fvk: String,
    /// ZIP 316 unified full viewing key, Orchard component only (uview… / uviewtest…).
    pub ufvk: String,
    /// The bond address: Orchard-receiver-only UA at diversifier index 0.
    pub address: String,
    /// Chain height when the key was made: a watch-only wallet for it starts scanning here.
    pub created_height: u32,
}

fn rng() -> rand_core06::OsRng {
    rand_core06::OsRng
}

fn ident(id: u16) -> anyhow::Result<Identifier> {
    Identifier::try_from(id).map_err(|e| anyhow!("bad FROST identifier {id}: {e}"))
}

/// The small integer behind a FROST identifier (its scalar encoding is little-endian).
pub fn ident_u16(id: &Identifier) -> u16 {
    let b = id.serialize();
    if b.len() < 2 || b[2..].iter().any(|x| *x != 0) {
        return 0;
    }
    u16::from_le_bytes([b[0], b[1]])
}

pub fn role_name(id: u16) -> &'static str {
    ROLES.get(usize::from(id).wrapping_sub(1)).copied().unwrap_or("participant")
}

// ---------------------------------------------------------------------------------------------
// Distributed key generation (frost-core `keys::dkg`, three rounds; each party keeps its secret).

pub fn dkg_round1(id: u16) -> anyhow::Result<(dkg::round1::SecretPackage, dkg::round1::Package)> {
    dkg::part1(ident(id)?, MAX_SIGNERS, MIN_SIGNERS, rng()).map_err(|e| anyhow!("DKG round 1: {e}"))
}

/// `others`: round-1 packages from every other participant.
pub fn dkg_round2(
    secret: dkg::round1::SecretPackage,
    others: &BTreeMap<Identifier, dkg::round1::Package>,
) -> anyhow::Result<(dkg::round2::SecretPackage, BTreeMap<Identifier, dkg::round2::Package>)> {
    dkg::part2(secret, others).map_err(|e| anyhow!("DKG round 2: {e}"))
}

/// `round1`: the other participants' round-1 packages; `round2`: the round-2 packages they sent us.
/// The result is normalised so the group key has an even y coordinate, which Orchard requires of `ak`.
pub fn dkg_round3(
    secret: &dkg::round2::SecretPackage,
    round1: &BTreeMap<Identifier, dkg::round1::Package>,
    round2: &BTreeMap<Identifier, dkg::round2::Package>,
) -> anyhow::Result<(KeyPackage, PublicKeyPackage)> {
    let (kp, pkp) = dkg::part3(secret, round1, round2).map_err(|e| anyhow!("DKG round 3: {e}"))?;
    let even = pkp.has_even_y();
    Ok((kp.into_even_y(Some(even)), pkp.into_even_y(Some(even))))
}

/// All three parties in one process (the demo and the tests). Returns the key packages in
/// identifier order and the shared public key package.
pub fn dkg_local() -> anyhow::Result<(Vec<KeyPackage>, PublicKeyPackage)> {
    let mut secrets1 = BTreeMap::new();
    let mut packages1 = BTreeMap::new();
    for id in 1..=MAX_SIGNERS {
        let (s, p) = dkg_round1(id)?;
        secrets1.insert(ident(id)?, s);
        packages1.insert(ident(id)?, p);
    }
    let others1 = |me: &Identifier| -> BTreeMap<Identifier, dkg::round1::Package> {
        packages1.iter().filter(|(k, _)| *k != me).map(|(k, v)| (*k, v.clone())).collect()
    };
    let mut secrets2 = BTreeMap::new();
    let mut inbox2: BTreeMap<Identifier, BTreeMap<Identifier, dkg::round2::Package>> = BTreeMap::new();
    for (me, secret) in secrets1 {
        let (s2, out) = dkg_round2(secret, &others1(&me))?;
        secrets2.insert(me, s2);
        for (to, pkg) in out {
            inbox2.entry(to).or_default().insert(me, pkg);
        }
    }
    let mut kps = Vec::new();
    let mut group: Option<PublicKeyPackage> = None;
    for (me, s2) in &secrets2 {
        let received = inbox2.remove(me).unwrap_or_default();
        let (kp, pkp) = dkg_round3(s2, &others1(me), &received)?;
        match &group {
            None => group = Some(pkp),
            Some(g) if *g == pkp => {}
            Some(_) => bail!("DKG participants disagree on the group key"),
        }
        kps.push(kp);
    }
    Ok((kps, group.expect("three participants")))
}

// ---------------------------------------------------------------------------------------------
// From the group key to Orchard keys.

/// PRF^expand-style derivation of the FVK components that are not `ak`. Deterministic in `ak`:
/// every party gets the same FVK, and anyone holding the FVK can re-derive it (it is public anyway).
fn expand(ak: &[u8; 32], t: u8) -> [u8; 64] {
    let h = blake2b_simd::Params::new().hash_length(64).personal(FVK_PERSONAL).to_state().update(ak).update(&[t]).finalize();
    let mut out = [0u8; 64];
    out.copy_from_slice(h.as_bytes());
    out
}

/// The group verifying key as Orchard's `ak` encoding (32 bytes, even y).
pub fn group_ak(pkp: &PublicKeyPackage) -> anyhow::Result<[u8; 32]> {
    let bytes = pkp.verifying_key().serialize().map_err(|e| anyhow!("serialising group key: {e}"))?;
    let ak: [u8; 32] = bytes.as_slice().try_into().map_err(|_| anyhow!("group key is not 32 bytes"))?;
    if ak[31] & 0x80 != 0 {
        bail!("group key has an odd y coordinate; the DKG output was not normalised");
    }
    Ok(ak)
}

/// The Orchard full viewing key for a group key: `ak` from FROST, `nk` and `rivk` derived from it.
pub fn bond_fvk(ak: &[u8; 32]) -> anyhow::Result<FullViewingKey> {
    let nk = pasta_curves::pallas::Base::from_uniform_bytes(&expand(ak, 0x01)).to_repr();
    let rivk = pasta_curves::pallas::Scalar::from_uniform_bytes(&expand(ak, 0x02)).to_repr();
    let mut raw = [0u8; 96];
    raw[..32].copy_from_slice(ak);
    raw[32..64].copy_from_slice(&nk);
    raw[64..].copy_from_slice(&rivk);
    FullViewingKey::from_bytes(&raw).ok_or_else(|| anyhow!("derived full viewing key is invalid"))
}

/// The public artefacts of a group key on `network`.
pub fn group_file(pkp: &PublicKeyPackage, network: Network, created_height: u32) -> anyhow::Result<GroupFile> {
    let ak = group_ak(pkp)?;
    let fvk = bond_fvk(&ak)?;
    let ufvk = UnifiedFullViewingKey::from_orchard_fvk(fvk.clone())
        .map_err(|e| anyhow!("unified full viewing key: {e:?}"))?
        .encode(&network)
        .map_err(|e| anyhow!("encoding the unified full viewing key: {e:?}"))?;
    let address = encode_orchard(&network, fvk.address_at(0u32, Scope::External));
    Ok(GroupFile {
        version: 1,
        network: chain_name(network).into(),
        threshold: MIN_SIGNERS,
        participants: MAX_SIGNERS,
        public_key_package: hex::encode(pkp.serialize().map_err(|e| anyhow!("serialising public key package: {e}"))?),
        ak: hex::encode(ak),
        fvk: hex::encode(fvk.to_bytes()),
        ufvk,
        address,
        created_height,
    })
}

pub fn share_file(kp: &KeyPackage, pkp: &PublicKeyPackage, network: Network) -> anyhow::Result<ShareFile> {
    let id = ident_u16(kp.identifier());
    Ok(ShareFile {
        version: 1,
        network: chain_name(network).into(),
        role: role_name(id).into(),
        identifier: id,
        key_package: hex::encode(kp.serialize().map_err(|e| anyhow!("serialising key package: {e}"))?),
        public_key_package: hex::encode(pkp.serialize().map_err(|e| anyhow!("serialising public key package: {e}"))?),
    })
}

pub fn parse_key_package(hex_str: &str) -> anyhow::Result<KeyPackage> {
    KeyPackage::deserialize(&hex::decode(hex_str.trim()).context("key package hex")?).map_err(|e| anyhow!("key package: {e}"))
}

pub fn parse_public_key_package(hex_str: &str) -> anyhow::Result<PublicKeyPackage> {
    PublicKeyPackage::deserialize(&hex::decode(hex_str.trim()).context("public key package hex")?)
        .map_err(|e| anyhow!("public key package: {e}"))
}

pub fn read_share(path: &Path) -> anyhow::Result<ShareFile> {
    serde_json::from_slice(&fs::read(path).with_context(|| format!("reading share {}", path.display()))?)
        .with_context(|| format!("parsing share {}", path.display()))
}

pub fn read_group(path: &Path) -> anyhow::Result<GroupFile> {
    serde_json::from_slice(&fs::read(path).with_context(|| format!("reading group file {}", path.display()))?)
        .with_context(|| format!("parsing group file {}", path.display()))
}

// ---------------------------------------------------------------------------------------------
// Re-randomized signing. `alpha` is the Orchard action's spend-auth randomizer (32 bytes, the
// little-endian Pallas scalar the PCZT carries); the aggregate verifies under rk = ak + [alpha] G.

pub fn sign_round1(kp: &KeyPackage) -> (round1::SigningNonces, round1::SigningCommitments) {
    round1::commit(kp.signing_share(), &mut rng())
}

fn randomizer(alpha: &[u8; 32]) -> anyhow::Result<Randomizer> {
    Randomizer::deserialize(alpha).map_err(|e| anyhow!("alpha is not a Pallas scalar: {e}"))
}

pub fn sign_round2(
    kp: &KeyPackage,
    nonces: &round1::SigningNonces,
    package: &SigningPackage,
    alpha: &[u8; 32],
) -> anyhow::Result<round2::SignatureShare> {
    // `sign` is deprecated in favour of coordinator-chosen random seeds; here the randomizer is
    // the transaction builder's own uniformly random `alpha`, which is exactly what rk needs.
    #[allow(deprecated)]
    frost_rerandomized::sign(package, nonces, kp, randomizer(alpha)?).map_err(|e| anyhow!("FROST round 2: {e}"))
}

/// The 64-byte RedPallas signature (R || s) for `package` under the randomized group key.
pub fn sign_aggregate(
    package: &SigningPackage,
    shares: &BTreeMap<Identifier, round2::SignatureShare>,
    pkp: &PublicKeyPackage,
    alpha: &[u8; 32],
) -> anyhow::Result<[u8; 64]> {
    let params = RandomizedParams::from_randomizer(pkp.verifying_key(), randomizer(alpha)?);
    let sig = frost::rerandomized::aggregate(package, shares, pkp, &params).map_err(|e| anyhow!("FROST aggregate: {e}"))?;
    let bytes = sig.serialize().map_err(|e| anyhow!("serialising signature: {e}"))?;
    bytes.as_slice().try_into().map_err(|_| anyhow!("signature is not 64 bytes"))
}

/// Both rounds in one process for `signers` (any `MIN_SIGNERS` of the three).
pub fn threshold_sign(signers: &[KeyPackage], pkp: &PublicKeyPackage, msg: &[u8; 32], alpha: &[u8; 32]) -> anyhow::Result<[u8; 64]> {
    if signers.len() < usize::from(MIN_SIGNERS) {
        bail!("{} signer(s) given; the bond needs {MIN_SIGNERS}", signers.len());
    }
    let mut nonces = BTreeMap::new();
    let mut commitments = BTreeMap::new();
    for kp in signers {
        let (n, c) = sign_round1(kp);
        nonces.insert(*kp.identifier(), n);
        commitments.insert(*kp.identifier(), c);
    }
    let package = SigningPackage::new(commitments, msg);
    let mut shares = BTreeMap::new();
    for kp in signers {
        shares.insert(*kp.identifier(), sign_round2(kp, &nonces[kp.identifier()], &package, alpha)?);
    }
    sign_aggregate(&package, &shares, pkp, alpha)
}

// ---------------------------------------------------------------------------------------------
// Spending the bond: PCZT built by the watch-only wallet, Ironwood spends signed with FROST.

enum SignErr {
    Parse(low_level_signer::OrchardParseError),
    Other(anyhow::Error),
}
impl From<low_level_signer::OrchardParseError> for SignErr {
    fn from(e: low_level_signer::OrchardParseError) -> Self {
        SignErr::Parse(e)
    }
}
impl From<anyhow::Error> for SignErr {
    fn from(e: anyhow::Error) -> Self {
        SignErr::Other(e)
    }
}
impl std::fmt::Display for SignErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SignErr::Parse(e) => write!(f, "parsing the PCZT for signing: {e:?}"),
            SignErr::Other(e) => write!(f, "{e:#}"),
        }
    }
}

/// Builds, proves, FROST-signs and broadcasts a spend from the bond wallet (`w`, watch-only,
/// opened from the group's FVK) to `outputs`. `signers` are any two of the three key packages.
pub async fn spend(w: &mut Wallet, signers: &[KeyPackage], pkp: &PublicKeyPackage, outputs: Vec<OutputReq>) -> Result<SendReport, WalletError> {
    if !w.view_only() {
        return Err(WalletError::BadRequest("the bond wallet must be watch-only (opened from the group's viewing key)".into()));
    }
    let ak = group_ak(pkp)?;
    let fvk = bond_fvk(&ak)?;
    let have = w.db.get_account(w.account).map_err(|e| anyhow!("reading account: {e}"))?.and_then(|a| a.ufvk().and_then(|u| u.orchard().map(|o| o.to_bytes())));
    if have != Some(fvk.to_bytes()) {
        return Err(WalletError::BadRequest("this wallet was not opened from the bond group's viewing key".into()));
    }
    let ak = SpendValidatingKey::from(fvk);
    let request = w.build_request(&outputs)?;

    let t0 = Instant::now();
    let proposal = w.propose(request)?;
    let fee = proposal.steps().first().balance().fee_required();
    let pczt = create_pczt_from_proposal::<_, _, Infallible, _, Infallible, _>(
        &mut w.db,
        &w.params,
        &SystemClock,
        &mut os_rng(),
        w.account,
        OvkPolicy::Sender,
        &proposal,
        None,
        BundlePadding::DEFAULT,
    )
    .map_err(|e| WalletError::Other(anyhow!("creating the PCZT failed: {e}")))?;
    let propose_ms = t0.elapsed().as_millis();

    // Only an Ironwood bundle may need proving; a legacy Orchard or Sapling part would mean the
    // proposal check above was bypassed.
    let t1 = Instant::now();
    let prover = Prover::new(pczt);
    if prover.requires_orchard_proof() || prover.requires_sapling_proofs() {
        return Err(WalletError::Privacy("PCZT has legacy Orchard or Sapling parts; refusing".into()));
    }
    let pczt = tokio::task::block_in_place(|| {
        let pk = cached_orchard_proving_key(OrchardCircuitVersion::PostNu6_3);
        prover.create_ironwood_proof(os_rng(), pk)
    })
    .map_err(|e| WalletError::Other(anyhow!("proving the Ironwood bundle failed: {e:?}")))?
    .finish();
    let prove_ms = t1.elapsed().as_millis();

    // The shielded sighash commits to every effect of the transaction: that is the FROST message.
    let sighash = Signer::new(pczt.clone()).map_err(|e| anyhow!("computing the sighash: {e:?}"))?.shielded_sighash();
    let t2 = Instant::now();
    let mut signed_actions = 0usize;
    let pczt = low_level_signer::Signer::new(pczt)
        .sign_ironwood_with::<SignErr, _>(|_, bundle, tx_modifiable| {
            for (i, action) in bundle.actions_mut().iter_mut().enumerate() {
                let Some(alpha) = *action.spend().alpha() else { continue };
                if action.spend().spend_auth_sig().is_some() {
                    continue; // a dummy spend, signed by the IO finalizer with its throwaway key
                }
                if ak.randomize(&alpha) != *action.spend().rk() {
                    continue; // not our note
                }
                let sig = threshold_sign(signers, pkp, &sighash, &alpha.to_repr())?;
                action
                    .apply_signature(sighash, redpallas::Signature::from(sig))
                    .map_err(|e| anyhow!("action {i}: the FROST signature does not verify under rk: {e}"))?;
                signed_actions += 1;
            }
            // Signatures commit to the effects: nothing may be added or changed after this.
            *tx_modifiable &= !(0b0000_0001 | 0b0000_0010 | 0b1000_0000);
            Ok(())
        })
        .map_err(|e| WalletError::Other(anyhow!("signing the bond spend: {e}")))?
        .finish();
    if signed_actions == 0 {
        return Err(WalletError::Other(anyhow!("no Ironwood action in the PCZT spends a bond note")));
    }
    let sign_ms = t2.elapsed().as_millis();

    let txid = tokio::task::block_in_place(|| {
        let vk = orchard::circuit::VerifyingKey::build(OrchardCircuitVersion::PostNu6_3);
        extract_and_store_transaction_from_pczt::<_, ReceivedNoteId>(&mut w.db, &SystemClock, &mut os_rng(), pczt, None, Some(&vk))
    })
    .map_err(|e| WalletError::Other(anyhow!("extracting the transaction from the PCZT failed: {e}")))?;
    let (actions, broadcast_ms, expiry_height) = w.broadcast_built(txid).await?;
    info!("broadcast FROST-signed bond spend {txid} ({signed_actions} FROST signature(s), {actions} actions, fee {}, sign {sign_ms} ms)", fee.into_u64());
    Ok(SendReport {
        txid: txid.to_string(),
        fee_zats: fee.into_u64().to_string(),
        actions,
        propose_ms,
        prove_ms,
        broadcast_ms,
        expiry_height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use orchard::keys::SpendValidatingKey;

    #[test]
    fn dkg_yields_an_even_y_group_key_and_a_valid_orchard_fvk() {
        let (kps, pkp) = dkg_local().unwrap();
        assert_eq!(kps.len(), 3);
        let ak = group_ak(&pkp).unwrap();
        assert_eq!(ak[31] & 0x80, 0);
        for kp in &kps {
            assert!(kp.has_even_y());
            assert_eq!(kp.verifying_key(), pkp.verifying_key());
        }
        let fvk = bond_fvk(&ak).unwrap();
        assert_eq!(&fvk.to_bytes()[..32], &ak);
        // Deterministic: the same ak gives the same FVK (every party derives it alone).
        assert_eq!(bond_fvk(&ak).unwrap().to_bytes(), fvk.to_bytes());
        let g = group_file(&pkp, Network::TestNetwork, 1).unwrap();
        assert!(g.address.starts_with("utest1"), "{}", g.address);
        assert!(g.ufvk.starts_with("uviewtest1"), "{}", g.ufvk);
        // Round trip through the files.
        let share = share_file(&kps[2], &pkp, Network::TestNetwork).unwrap();
        assert_eq!(share.identifier, 3);
        assert_eq!(share.role, "arbiter");
        let kp = parse_key_package(&share.key_package).unwrap();
        assert_eq!(kp, kps[2]);
        assert_eq!(parse_public_key_package(&g.public_key_package).unwrap(), pkp);
    }

    #[test]
    fn two_of_three_signs_under_the_randomized_orchard_key_and_one_does_not() {
        let (kps, pkp) = dkg_local().unwrap();
        let ak = group_ak(&pkp).unwrap();
        let fvk = bond_fvk(&ak).unwrap();
        let svk = SpendValidatingKey::from(fvk);
        let msg = [7u8; 32];
        let alpha_scalar = pasta_curves::pallas::Scalar::from_uniform_bytes(&[9u8; 64]);
        let alpha = alpha_scalar.to_repr();
        for pair in [[0, 1], [0, 2], [1, 2]] {
            let signers = [kps[pair[0]].clone(), kps[pair[1]].clone()];
            let sig = threshold_sign(&signers, &pkp, &msg, &alpha).unwrap();
            // Verified by orchard 0.16's own RedPallas (reddsa 0.6): the two crates agree.
            let rk = svk.randomize(&alpha_scalar);
            rk.verify(&msg, &redpallas::Signature::from(sig)).expect("FROST signature verifies under rk");
            // Not under a different randomizer, and not for another message.
            let other = svk.randomize(&pasta_curves::pallas::Scalar::from_uniform_bytes(&[10u8; 64]));
            assert!(other.verify(&msg, &redpallas::Signature::from(sig)).is_err());
            assert!(rk.verify(&[8u8; 32], &redpallas::Signature::from(sig)).is_err());
        }
        assert!(threshold_sign(&kps[..1], &pkp, &msg, &alpha).is_err());
        // All three may sign too.
        assert!(threshold_sign(&kps, &pkp, &msg, &alpha).is_ok());
    }

    #[test]
    fn the_networked_rounds_compose_like_the_local_ones() {
        // Party 1 and 3 sign; the coordinator only ever sees commitments and shares.
        let (kps, pkp) = dkg_local().unwrap();
        let msg = [1u8; 32];
        let alpha = pasta_curves::pallas::Scalar::from_uniform_bytes(&[2u8; 64]).to_repr();
        let (n1, c1) = sign_round1(&kps[0]);
        let (n3, c3) = sign_round1(&kps[2]);
        let mut commitments = BTreeMap::new();
        commitments.insert(*kps[0].identifier(), c1);
        commitments.insert(*kps[2].identifier(), c3);
        let package = SigningPackage::new(commitments, &msg);
        let pkg_bytes = package.serialize().unwrap();
        let package = SigningPackage::deserialize(&pkg_bytes).unwrap();
        let mut shares = BTreeMap::new();
        shares.insert(*kps[0].identifier(), sign_round2(&kps[0], &n1, &package, &alpha).unwrap());
        shares.insert(*kps[2].identifier(), sign_round2(&kps[2], &n3, &package, &alpha).unwrap());
        let sig = sign_aggregate(&package, &shares, &pkp, &alpha).unwrap();
        let svk = SpendValidatingKey::from(bond_fvk(&group_ak(&pkp).unwrap()).unwrap());
        let rk = svk.randomize(&pasta_curves::pallas::Scalar::from_repr(alpha).unwrap());
        rk.verify(&msg, &redpallas::Signature::from(sig)).unwrap();
        // A share for the wrong message is caught by aggregation (cheater detection).
        let bad_package = SigningPackage::new(package.signing_commitments().clone(), &[3u8; 32]);
        shares.insert(*kps[2].identifier(), sign_round2(&kps[2], &n3, &bad_package, &alpha).unwrap());
        assert!(sign_aggregate(&package, &shares, &pkp, &alpha).is_err());
    }
}
