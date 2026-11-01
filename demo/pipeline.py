#!/usr/bin/env python3
"""A live AX demo: Orbit's nightly model pipeline as a 16-task execution tree.

Tasks are created as their dependencies finish, so the tree grows in AX Studio's
Network page. A task runs its step for a few seconds, then is suspended (done).
The final canary stays running. A run takes about a minute and needs no network.

    demo/pipeline.py run  [--context kind-kind] [--atespace default]
    demo/pipeline.py down [--context kind-kind] [--atespace default]
"""
import argparse
import json
import subprocess
import sys
import threading
import time

# name: (workspace, seconds, dependencies). A seconds of None keeps the task running.
TASKS = {
    'fetch-trips':    ('orbit-data', 4, []),
    'shard-sf':       ('orbit-data', 5, ['fetch-trips']),
    'shard-nyc':      ('orbit-data', 7, ['fetch-trips']),
    'shard-la':       ('orbit-data', 4, ['fetch-trips']),
    'shard-chi':      ('orbit-data', 6, ['fetch-trips']),
    'shard-sea':      ('orbit-data', 5, ['fetch-trips']),
    'shard-atx':      ('orbit-data', 6, ['fetch-trips']),
    'merge-features': ('orbit-data', 4, ['shard-sf', 'shard-nyc', 'shard-la', 'shard-chi', 'shard-sea', 'shard-atx']),
    'train-surge':    ('orbit-models', 10, ['merge-features']),
    'train-eta':      ('orbit-models', 8, ['merge-features']),
    'train-fraud':    ('orbit-models', 7, ['merge-features']),
    'eval-accuracy':  ('orbit-evals', 5, ['train-surge', 'train-eta']),
    'eval-fairness':  ('orbit-evals', 6, ['train-surge']),
    'eval-latency':   ('orbit-evals', 3, ['train-eta', 'train-fraud']),
    'release-report': ('orbit-release', 3, ['eval-accuracy', 'eval-fairness', 'eval-latency']),
    'canary':         ('orbit-release', None, ['release-report']),
}

WORKSPACES = {
    'orbit-data': 'Trip logs from six cities, sharded and merged into features.',
    'orbit-models': 'Surge, ETA and fraud models trained on the merged features.',
    'orbit-evals': 'Accuracy, fairness and latency gates for the trained models.',
    'orbit-release': 'Release report and the canary that serves the new models.',
}

# Runs inside each task: prints believable progress for its step.
STEP = r'''
import random, sys, time
name, secs = sys.argv[1], float(sys.argv[2])
random.seed(name)
verbs = {"fetch": "downloading trips", "shard": "partitioning trips", "merge": "joining shards",
         "train": "training", "eval": "scoring", "release": "writing report", "canary": "serving"}
verb = verbs[name.split("-")[0]]
print(f"[{name}] start: {verb}", flush=True)
if secs <= 0:
    n = 0
    while True:
        n += random.randint(20, 60)
        print(f"[{name}] {n} requests served, p99 {random.randint(38, 52)} ms, errors 0", flush=True)
        time.sleep(2)
steps = 5
for i in range(1, steps + 1):
    time.sleep(secs / steps)
    extra = f"loss {1.2 / i + random.random() / 20:.3f}" if verb == "training" else f"{random.randint(2, 9) * i}k rows"
    print(f"[{name}] {verb} {i * 100 // steps}%  {extra}", flush=True)
print(f"[{name}] done", flush=True)
'''

lock = threading.Lock()
start = time.time()


def log(mark, msg):
    with lock:
        print(f'[{time.time() - start:5.1f}s] {mark} {msg}', flush=True)


def ax(scope, *args, stdin=None, check=True):
    r = subprocess.run(['ax', *scope, *args], input=stdin, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f'ax {" ".join(args)}: {r.stderr.strip() or r.stdout.strip()}')
    return r.stdout


def block(s, indent):
    return '|\n' + '\n'.join(' ' * indent + line for line in s.strip('\n').split('\n'))


def workspace_doc(name, about):
    return f'''apiVersion: ax.io/v1alpha1
kind: Workspace
metadata:
  name: {name}
spec:
  files:
    - path: "README.md"
      content: {block(f'# {name}' + chr(10) + chr(10) + about, 8)}
    - path: "step.py"
      content: {block(STEP, 8)}'''


def task_doc(name):
    ws, secs, _ = TASKS[name]
    cmd = f'cd /workspace && python3 -u step.py {name} {secs or 0}; exec sleep infinity'
    return f'''apiVersion: ax.io/v1alpha1
kind: Task
metadata:
  name: {name}
spec:
  command: ["sh", "-c", {json.dumps(cmd)}]
  resources:
    limits:
      cpu: "250m"
      memory: "256Mi"
  workspace:
    name: {ws}
  debug: true'''


def phase(scope, name):
    for line in ax(scope, 'get', 'task', name, check=False).splitlines():
        if line.strip().startswith('phase:'):
            return line.split(':', 1)[1].strip()
    return ''


def run_task(scope, name, done, failed):
    ws, secs, deps = TASKS[name]
    for d in deps:
        done[d].wait()
        if failed:
            return
    try:
        ax(scope, 'apply', '-f', '-', stdin=task_doc(name))
        ax(scope, 'resume', 'task', name)
        while phase(scope, name) != 'Running':
            time.sleep(0.5)
        log('▶', f'{name}  ({ws})')
        if secs is None:
            log('●', f'{name} is live')
        else:
            time.sleep(secs)
            ax(scope, 'suspend', 'task', name)
            log('✓', name)
    except Exception as e:  # noqa: BLE001 — report and stop the rest of the tree
        failed.append(name)
        log('✗', f'{name}: {e}')
    finally:
        done[name].set()


def run(scope):
    existing = ax(scope, 'get', 'tasks')
    clash = [n for n in TASKS if any(line.split()[:1] == [n] for line in existing.splitlines())]
    if clash:
        sys.exit(f'already exists: {", ".join(clash)}. Run "down" first.')
    ax(scope, 'apply', '-f', '-', stdin='\n---\n'.join(workspace_doc(n, a) for n, a in WORKSPACES.items()))
    log('·', f'{len(WORKSPACES)} workspaces ready; starting {len(TASKS)} tasks')
    done = {n: threading.Event() for n in TASKS}
    failed = []
    threads = [threading.Thread(target=run_task, args=(scope, n, done, failed)) for n in TASKS]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    if failed:
        sys.exit(f'stopped: {", ".join(failed)} failed')
    log('★', f'pipeline finished in {time.time() - start:.0f}s; canary is serving')


def down(scope):
    for n in TASKS:
        if ax(scope, 'delete', 'task', n, check=False):
            print('deleted task', n)
    time.sleep(3)
    for n in WORKSPACES:
        if ax(scope, 'delete', 'workspace', n, check=False):
            print('deleted workspace', n)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('command', choices=['run', 'down'])
    p.add_argument('--context', default='kind-kind')
    p.add_argument('--atespace', default='default')
    a = p.parse_args()
    scope = ['--context', a.context, '-a', a.atespace]
    run(scope) if a.command == 'run' else down(scope)


if __name__ == '__main__':
    main()
