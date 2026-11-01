#!/usr/bin/env python3
"""A live AX demo: an agentic city simulation and its analysis, as a 13-task tree.

Three agents plan the city, forecast the weather and find tonight's events. Six
district tasks each simulate hundreds of rider and driver agents over a day, using
those results. Three analyses read every district's data, and a report task turns
them into findings. Sandboxes have no network, so this script carries each task's
out.json (read over ax ssh) to the tasks that depend on it as INPUT.

Tasks are created as their inputs become ready, so the tree grows in AX Studio's
Network page; finished tasks are suspended and the report stays running.
A run takes about a minute.

    demo/city.py run  [--context kind-kind] [--atespace default]
    demo/city.py down [--context kind-kind] [--atespace default]
"""
import argparse
import json
import pathlib
import subprocess
import sys
import threading
import time

DISTRICTS = ['mission', 'soma', 'marina', 'sunset', 'castro', 'richmond']
AGENTS = ['city-planner', 'weather-agent', 'events-agent']
SIMS = [f'district-{d}' for d in DISTRICTS]
ANALYSES = ['analyze-demand', 'analyze-surge', 'analyze-equity']

# name: (workspace, command, dependencies)
TASKS = {
    'city-planner': ('city-agents', 'python3 -u sim.py plan', []),
    'weather-agent': ('city-agents', 'python3 -u sim.py weather', []),
    'events-agent': ('city-agents', 'python3 -u sim.py events', []),
    **{f'district-{d}': ('city-sim', f'PACE={0.30 + 0.03 * i:.2f} python3 -u sim.py district {d}', AGENTS)
       for i, d in enumerate(DISTRICTS)},
    **{a: ('city-analysis', f'python3 -u analyze.py {a.split("-")[1]}', SIMS) for a in ANALYSES},
    'city-report': ('city-report', 'python3 -u report.py', ANALYSES),
}
LIVE = {'city-report'}  # left running at the end

WORKSPACES = {
    'city-agents': 'Agents that plan the city, forecast the weather and find events.',
    'city-sim': 'District simulations: rider and driver agents over one day.',
    'city-analysis': 'Demand, surge and equity analyses over the simulation data.',
    'city-report': 'Findings and a recommendation, served as report.md.',
}
CODE = pathlib.Path(__file__).with_name('city')

lock = threading.Lock()
start = time.time()


def log(mark, msg):
    with lock:
        print(f'[{time.time() - start:5.1f}s] {mark} {msg}', flush=True)


def ax(scope, *args, stdin=None, check=True):
    r = subprocess.run(['ax', *scope, *args], input=stdin, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f'ax {" ".join(args)}: {r.stderr.strip() or r.stdout.strip()}')
    return r


def block(s, indent):
    return '|\n' + '\n'.join((' ' * indent + line) if line else '' for line in s.strip('\n').split('\n'))


def workspace_doc(name, about):
    files = [('README.md', f'# {name}\n\n{about}\n')] + [(p.name, p.read_text()) for p in sorted(CODE.glob('*.py'))]
    doc = f'apiVersion: ax.io/v1alpha1\nkind: Workspace\nmetadata:\n  name: {name}\nspec:\n  files:'
    for path, content in files:
        doc += f'\n    - path: {json.dumps(path)}\n      content: {block(content, 8)}'
    return doc


def task_doc(name, inputs):
    ws, cmd, _ = TASKS[name]
    return f'''apiVersion: ax.io/v1alpha1
kind: Task
metadata:
  name: {name}
spec:
  command: ["sh", "-c", {json.dumps(f'cd /workspace && {cmd}; exec sleep infinity')}]
  env:
    - name: INPUT
      value: {json.dumps(json.dumps(inputs, separators=(',', ':')))}
  resources:
    limits:
      cpu: "250m"
      memory: "256Mi"
  workspace:
    name: {ws}
  debug: true'''


def phase(scope, name):
    for line in ax(scope, 'get', 'task', name, check=False).stdout.splitlines():
        if line.strip().startswith('phase:'):
            return line.split(':', 1)[1].strip()
    return ''


def output(scope, name):
    """Waits for the task to write out.json and returns it."""
    while True:
        r = ax(scope, 'ssh', name, '--', 'cat', '/workspace/out.json', check=False)
        if r.returncode == 0:
            try:
                return json.loads(r.stdout)
            except ValueError:
                pass
        time.sleep(1)


def summary(name, out):
    if name == 'city-planner':
        return f'{sum(d["residents"] for d in out["districts"].values())} residents in {len(out["districts"])} districts'
    if name == 'weather-agent':
        return f'storm peaks at {max(out["rain"]):.0%} rain'
    if name == 'events-agent':
        return ', '.join(e['name'] for e in out['events'])
    if name.startswith('district-'):
        t = out['ticks']
        return f'{sum(x[2] for x in t)} rides, peak surge {max(x[6] for x in t):.1f}x'
    return out.get('headline', '')


def run_task(scope, name, results, done, failed):
    ws, _, deps = TASKS[name]
    for d in deps:
        done[d].wait()
    if failed:
        done[name].set()
        return
    try:
        ax(scope, 'apply', '-f', '-', stdin=task_doc(name, {d: results[d] for d in deps}))
        ax(scope, 'resume', 'task', name)
        while phase(scope, name) != 'Running':
            time.sleep(0.5)
        log('▶', f'{name}  ({ws})')
        results[name] = output(scope, name)
        if name in LIVE:
            log('●', f'{name} is live')
        else:
            ax(scope, 'suspend', 'task', name)
            log('✓', f'{name}: {summary(name, results[name])}')
    except Exception as e:  # noqa: BLE001 — report and stop the rest of the tree
        failed.append(name)
        log('✗', f'{name}: {e}')
    finally:
        done[name].set()


def run(scope):
    existing = ax(scope, 'get', 'tasks').stdout.splitlines()
    clash = [n for n in TASKS if any(line.split()[:1] == [n] for line in existing)]
    if clash:
        sys.exit(f'already exists: {", ".join(clash)}. Run "down" first.')
    ax(scope, 'apply', '-f', '-', stdin='\n---\n'.join(workspace_doc(n, a) for n, a in WORKSPACES.items()))
    log('·', f'{len(WORKSPACES)} workspaces ready; starting {len(TASKS)} tasks')
    results, failed = {}, []
    done = {n: threading.Event() for n in TASKS}
    threads = [threading.Thread(target=run_task, args=(scope, n, results, done, failed)) for n in TASKS]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    if failed:
        sys.exit(f'stopped: {", ".join(failed)} failed')
    log('★', f'done in {time.time() - start:.0f}s; city-report is serving /workspace/report.md\n')
    print(results['city-report']['report'])


def down(scope):
    for n in TASKS:
        if ax(scope, 'delete', 'task', n, check=False).returncode == 0:
            print('deleted task', n)
    time.sleep(3)
    for n in WORKSPACES:
        if ax(scope, 'delete', 'workspace', n, check=False).returncode == 0:
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
