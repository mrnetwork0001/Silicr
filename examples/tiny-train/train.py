#!/usr/bin/env python3
"""tiny-train: a character-level bigram language model trained with minibatch SGD.

Standard library only, so it runs unchanged in python:3.12-slim and with any host
python3 (3.8+). Small, but real: the loss goes down, checkpoints resume exactly,
and the trained model writes text that looks (a little) like its corpus.

Silicr contract:
  - prints the loss every step and "SILICR_PROGRESS step=<n>" after it
  - writes checkpoints to $SILICR_CHECKPOINT_DIR every SILICR_CHECKPOINT_EVERY steps,
    and resumes from the newest one if present
  - writes model.json, metrics.json and sample.txt to $SILICR_OUTPUT_DIR
  - on SIGTERM/SIGINT: saves a checkpoint and partial outputs, then exits (143 / 130)

Env knobs (all optional):
  SILICR_STEPS             total training steps            (default 600)
  SILICR_STEP_DELAY_MS     sleep after each step, in ms     (default 250, so a demo run lasts ~2.5 min)
  SILICR_CHECKPOINT_EVERY  steps between checkpoints        (default 50)
  SILICR_BATCH             character pairs per step         (default 64)
  SILICR_LR                learning rate                    (default 5)
  SILICR_SEED              seed for batches and sampling    (default 1337)
  SILICR_OUTPUT_DIR        default ./output
  SILICR_CHECKPOINT_DIR    default ./checkpoints
"""

import hashlib
import json
import math
import os
import platform
import random
import re
import signal
import sys
import time

CORPUS = """
the market opened before dawn, as it always did, with nobody in the room.
a lab that wanted compute wrote down what it needed: four cards, twelve hours,
and a price it would not go above. it sealed the request and sent it to a few
providers it had never met. none of them learned who had asked. the chain saw a
transaction and nothing more: no sender, no amount, no words it could read.

the providers looked at the request and answered with sealed bids of their own.
each bid went to an address made for this one request and never used again.
the lab read the bids in private, picked the cheapest one it trusted, and sent
back a single word: accept. then the work began. the job travelled as noise
through a relay that stored it without understanding it, and the provider
opened it with a key that only two parties held.

every ten minutes the lab paid for the next ten minutes, and every ten minutes
the provider kept the job running. if the money stopped, the work stopped. if
the work stopped, the money stopped. neither side could lose more than one
small piece of time. there was no escrow and no judge, only a steady rhythm of
small payments and small proofs that the job was still moving forward.

when the run was over the results came back the same way they had gone out,
sealed and quiet. the lab had its model. the provider had its coins. the chain
had a handful of transactions that told it nothing at all, and the relay had a
pile of bytes that meant nothing to anyone who did not hold the key.

this is a small story about a simple idea. what you buy, and from whom, and for
how long, is your own business. a market can still work when nobody in the
middle can read the orders. the trick is to make the middle so thin that there
is nothing left in it to see.
"""


def env_int(name, default, lo=0):
    raw = os.environ.get(name, "")
    try:
        value = int(raw) if raw.strip() else default
    except ValueError:
        sys.exit(f"{name} must be an integer, got {raw!r}")
    return max(lo, value)


def env_float(name, default):
    raw = os.environ.get(name, "")
    try:
        return float(raw) if raw.strip() else default
    except ValueError:
        sys.exit(f"{name} must be a number, got {raw!r}")


STEPS = env_int("SILICR_STEPS", 600)
DELAY_S = env_int("SILICR_STEP_DELAY_MS", 250) / 1000.0
CKPT_EVERY = env_int("SILICR_CHECKPOINT_EVERY", 50, lo=1)
BATCH = env_int("SILICR_BATCH", 64, lo=1)
LR = env_float("SILICR_LR", 5.0)
SEED = env_int("SILICR_SEED", 1337)
OUT_DIR = os.environ.get("SILICR_OUTPUT_DIR") or os.path.join(os.getcwd(), "output")
CKPT_DIR = os.environ.get("SILICR_CHECKPOINT_DIR") or os.path.join(os.getcwd(), "checkpoints")
KEEP_CHECKPOINTS = 3

text = " ".join(CORPUS.split())  # collapse whitespace into single spaces
vocab = sorted(set(text))
index = {c: i for i, c in enumerate(vocab)}
V = len(vocab)
pairs = [(index[a], index[b]) for a, b in zip(text, text[1:])]
corpus_sha = hashlib.sha256(text.encode()).hexdigest()


def softmax(row):
    m = max(row)
    exps = [math.exp(x - m) for x in row]
    s = sum(exps)
    return [e / s for e in exps]


def train_step(W, step):
    """One SGD step on a minibatch drawn deterministically from (SEED, step)."""
    rng = random.Random(SEED * 1_000_003 + step)
    grads = {}
    loss = 0.0
    for _ in range(BATCH):
        a, b = pairs[rng.randrange(len(pairs))]
        p = softmax(W[a])
        loss -= math.log(max(p[b], 1e-12))
        g = grads.get(a)
        if g is None:
            g = grads[a] = [0.0] * V
        for j in range(V):
            g[j] += p[j]
        g[b] -= 1.0
    scale = LR / BATCH
    for a, g in grads.items():
        row = W[a]
        for j in range(V):
            row[j] -= scale * g[j]
    return loss / BATCH


def eval_loss(W):
    probs = [softmax(row) for row in W]
    return -sum(math.log(max(probs[a][b], 1e-12)) for a, b in pairs) / len(pairs)


def sample(W, n=400, start="t"):
    rng = random.Random(SEED + 7)
    probs = [softmax(row) for row in W]
    out = [start]
    cur = index.get(start, 0)
    for _ in range(n - 1):
        cur = rng.choices(range(V), weights=probs[cur])[0]
        out.append(vocab[cur])
    return "".join(out)


def write_json(path, obj):
    tmp = f"{path}.tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
        f.write("\n")
    os.replace(tmp, path)  # atomic: readers never see a half-written file


CKPT_RE = re.compile(r"^ckpt-(\d{6,})\.json$")


def list_checkpoints():
    try:
        names = os.listdir(CKPT_DIR)
    except FileNotFoundError:
        return []
    found = [(int(m.group(1)), n) for n in names for m in [CKPT_RE.match(n)] if m]
    return sorted(found)


def save_checkpoint(W, step, curve):
    os.makedirs(CKPT_DIR, exist_ok=True)
    path = os.path.join(CKPT_DIR, f"ckpt-{step:06d}.json")
    write_json(path, {"v": 1, "step": step, "vocab": "".join(vocab), "corpus_sha256": corpus_sha, "W": W, "curve": curve})
    for old_step, name in list_checkpoints()[:-KEEP_CHECKPOINTS]:
        try:
            os.remove(os.path.join(CKPT_DIR, name))
        except FileNotFoundError:
            pass
    return path


def load_latest_checkpoint():
    for step, name in reversed(list_checkpoints()):
        try:
            with open(os.path.join(CKPT_DIR, name)) as f:
                ck = json.load(f)
            if ck.get("vocab") != "".join(vocab) or ck.get("corpus_sha256") != corpus_sha:
                print(f"ignoring checkpoint {name}: it was made for a different corpus", flush=True)
                continue
            W = ck["W"]
            if len(W) != V or any(len(r) != V for r in W):
                raise ValueError("bad shape")
            return int(ck["step"]), W, ck.get("curve", [])
        except (OSError, ValueError, KeyError, TypeError) as e:
            print(f"ignoring unreadable checkpoint {name}: {e}", flush=True)
    return 0, None, []


stop_signal = None


def on_signal(signum, _frame):
    global stop_signal
    stop_signal = signum


def write_outputs(W, step, started, initial_eval, curve, resumed_from, completed):
    os.makedirs(OUT_DIR, exist_ok=True)
    final_eval = eval_loss(W)
    write_json(os.path.join(OUT_DIR, "model.json"), {
        "kind": "char-bigram",
        "vocab": "".join(vocab),
        "steps": step,
        "W": [[round(x, 5) for x in row] for row in W],
    })
    write_json(os.path.join(OUT_DIR, "metrics.json"), {
        "completed": completed,
        "steps_completed": step,
        "steps_target": STEPS,
        "resumed_from_step": resumed_from,
        "eval_loss_initial": round(initial_eval, 5),
        "eval_loss_final": round(final_eval, 5),
        "uniform_baseline": round(math.log(V), 5),
        "loss_curve": curve,
        "params": V * V,
        "vocab_size": V,
        "corpus_chars": len(text),
        "batch": BATCH,
        "lr": LR,
        "seed": SEED,
        "wall_time_s": round(time.time() - started, 3),
        "python": platform.python_version(),
    })
    with open(os.path.join(OUT_DIR, "sample.txt"), "w") as f:
        f.write(sample(W) + "\n")
    return final_eval


def main():
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    started = time.time()

    start_step, W, curve = load_latest_checkpoint()
    if W is None:
        W = [[0.0] * V for _ in range(V)]  # uniform predictions: loss starts at ln(V)
    initial_eval = eval_loss(W)
    print(
        f"tiny-train: char bigram LM, vocab={V}, params={V * V}, corpus={len(text)} chars, "
        f"steps={STEPS}, batch={BATCH}, lr={LR}"
        + (f", resuming from checkpoint at step {start_step}" if start_step else ""),
        flush=True,
    )
    print(f"eval loss at start: {initial_eval:.4f} (uniform baseline {math.log(V):.4f})", flush=True)

    step = start_step
    last_saved = start_step
    while step < STEPS and stop_signal is None:
        step += 1
        loss = train_step(W, step)
        print(f"step {step:5d}/{STEPS}  loss {loss:.4f}", flush=True)
        print(f"SILICR_PROGRESS step={step}", flush=True)
        if step % 10 == 0 or step == STEPS:
            curve.append([step, round(loss, 4)])
        if step % CKPT_EVERY == 0:
            save_checkpoint(W, step, curve)
            last_saved = step
            print(f"checkpoint saved at step {step} (eval loss {eval_loss(W):.4f})", flush=True)
        if DELAY_S > 0 and step < STEPS and stop_signal is None:
            time.sleep(DELAY_S)

    if step != last_saved:
        save_checkpoint(W, step, curve)
    completed = step >= STEPS
    final_eval = write_outputs(W, step, started, initial_eval, curve, start_step, completed)
    if not completed:
        name = signal.Signals(stop_signal).name if stop_signal else "stop"
        print(f"{name} received: checkpoint and partial outputs saved at step {step}, eval loss {final_eval:.4f}", flush=True)
        sys.exit(128 + (stop_signal or signal.SIGTERM))
    print(f"sample: {sample(W, 120)!r}", flush=True)
    print(
        f"done: {step} steps in {time.time() - started:.1f}s, eval loss {initial_eval:.4f} -> {final_eval:.4f}; "
        f"wrote model.json, metrics.json, sample.txt",
        flush=True,
    )


if __name__ == "__main__":
    main()
