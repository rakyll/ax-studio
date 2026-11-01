"""Shared plumbing for the AX demos: ax calls, manifests and the task lifecycle.

A demo hands each task its inputs as the INPUT env var and reads its result from
/workspace/out.json over ax ssh, since sandboxes have no network.
"""
import argparse
import json
import pathlib
import subprocess
import sys
import threading
import time

# Sandboxes receive workspace files in one env var, which ax caps at 32 KiB.
MAX_WORKSPACE_BYTES = 30_000


class Demo:
    def __init__(self, scope, code, workspaces, owns):
        self.scope = scope
        self.code = pathlib.Path(code)
        self.workspaces = workspaces  # name: README text
        self.owns = owns  # task name -> whether this demo created it
        self.start = time.time()
        self.lock = threading.Lock()

    def log(self, mark, msg):
        with self.lock:
            print(f'[{time.time() - self.start:5.1f}s] {mark} {msg}', flush=True)

    def ax(self, *args, stdin=None, check=True):
        r = subprocess.run(['ax', *self.scope, *args], input=stdin, capture_output=True, text=True)
        if check and r.returncode != 0:
            raise RuntimeError(f'ax {" ".join(args)}: {r.stderr.strip() or r.stdout.strip()}')
        return r

    def tasks(self):
        lines = self.ax('get', 'tasks').stdout.splitlines()[1:]
        return [line.split()[0] for line in lines if line.strip()]

    def apply_workspaces(self):
        clash = [n for n in self.tasks() if self.owns(n)]
        if clash:
            sys.exit(f'already exists: {", ".join(clash)}. Run "down" first.')
        docs = [self._workspace_doc(n, about) for n, about in self.workspaces.items()]
        self.ax('apply', '-f', '-', stdin='\n---\n'.join(docs))
        self.log('·', f'{len(docs)} workspaces ready')

    def run(self, name, workspace, command, inputs=None, summary=None, live=False):
        """Runs a task to completion and returns its out.json; a live task keeps running."""
        self.ax('apply', '-f', '-', stdin=self._task_doc(name, workspace, command, inputs or {}))
        self.ax('resume', 'task', name)
        while self._phase(name) != 'Running':
            time.sleep(0.5)
        self.log('▶', f'{name}  ({workspace})')
        out = self._output(name)
        if live:
            self.log('●', f'{name} is live')
        else:
            self.ax('suspend', 'task', name)
            self.log('✓', f'{name}: {summary(out)}' if summary else name)
        return out

    def parallel(self, jobs):
        """Runs (name, fn) jobs at once and returns {name: result}; any failure stops the demo."""
        results, errors = {}, []

        def go(name, fn):
            try:
                results[name] = fn()
            except Exception as e:  # noqa: BLE001 — reported below
                errors.append(name)
                self.log('✗', f'{name}: {e}')

        threads = [threading.Thread(target=go, args=job) for job in jobs]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        if errors:
            sys.exit(f'stopped: {", ".join(errors)} failed')
        return results

    def down(self):
        for n in self.tasks():
            if self.owns(n) and self.ax('delete', 'task', n, check=False).returncode == 0:
                print('deleted task', n)
        time.sleep(3)
        for n in self.workspaces:
            if self.ax('delete', 'workspace', n, check=False).returncode == 0:
                print('deleted workspace', n)

    def _workspace_doc(self, name, about):
        files = [('README.md', f'# {name}\n\n{about}\n')] + [(p.name, p.read_text()) for p in sorted(self.code.glob('*.py'))]
        if sum(len(c) for _, c in files) > MAX_WORKSPACE_BYTES:
            sys.exit(f'{self.code} is too big for a workspace ({MAX_WORKSPACE_BYTES} bytes max)')
        doc = f'apiVersion: ax.io/v1alpha1\nkind: Workspace\nmetadata:\n  name: {name}\nspec:\n  files:'
        for path, content in files:
            doc += f'\n    - path: {json.dumps(path)}\n      content: {_block(content, 8)}'
        return doc

    def _task_doc(self, name, workspace, command, inputs):
        return f'''apiVersion: ax.io/v1alpha1
kind: Task
metadata:
  name: {name}
spec:
  command: ["sh", "-c", {json.dumps(f'cd /workspace && {command}; exec sleep infinity')}]
  env:
    - name: INPUT
      value: {json.dumps(json.dumps(inputs, separators=(',', ':')))}
  resources:
    limits:
      cpu: "250m"
      memory: "256Mi"
  workspace:
    name: {workspace}
  debug: true'''

    def _phase(self, name):
        for line in self.ax('get', 'task', name, check=False).stdout.splitlines():
            if line.strip().startswith('phase:'):
                return line.split(':', 1)[1].strip()
        return ''

    def _output(self, name):
        while True:
            r = self.ax('ssh', name, '--', 'cat', '/workspace/out.json', check=False)
            if r.returncode == 0:
                try:
                    return json.loads(r.stdout)
                except ValueError:
                    pass
            time.sleep(1)


def _block(s, indent):
    return '|\n' + '\n'.join((' ' * indent + line) if line else '' for line in s.strip('\n').split('\n'))


def main(doc, make, run):
    """Parses run|down [--context] [--atespace], builds the demo with make(scope) and runs it."""
    p = argparse.ArgumentParser(description=doc, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('command', choices=['run', 'down'])
    p.add_argument('--context', default='kind-kind')
    p.add_argument('--atespace', default='default')
    a = p.parse_args()
    demo = make(['--context', a.context, '-a', a.atespace])
    run(demo) if a.command == 'run' else demo.down()
