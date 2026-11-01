#!/usr/bin/env python3
"""A live AX demo: a research agent team with long trajectories.

A lead planner splits "Where should Orbit launch next?" into five research
dimensions. Five researchers each run a long think, search, read, note and reflect
trajectory over an offline corpus, hitting dead ends and rephrasing as they go. A
fact-checker verifies every cited figure; for each stale one it finds, a revision
agent is spawned, so the shape of the tree is decided at runtime. A report writer
ranks the cities and shows how fact-checking changed the answer.

Each agent prints its trajectory as it goes, so open a task's logs in AX Studio to
follow it. Finished tasks are suspended and the report writer stays running.
A run takes about a minute.

    demo/research.py run  [--context kind-kind] [--atespace default]
    demo/research.py down [--context kind-kind] [--atespace default]
"""
import pathlib
import time

import axdemo

DIMENSIONS = ['demand', 'regulation', 'competition', 'economics', 'operations']
FIXED = {'lead-planner', 'fact-checker', 'report-writer', *(f'researcher-{d}' for d in DIMENSIONS)}
WORKSPACES = {
    'research-lead': 'The lead planner, which splits the question into research dimensions.',
    'research-team': 'Researchers and revision agents, working over an offline corpus.',
    'research-review': 'The fact-checker, which verifies every cited figure.',
    'research-report': 'The final recommendation, served as report.md.',
}


def run(demo):
    demo.apply_workspaces()
    plan = demo.run('lead-planner', 'research-lead', 'python3 -u agent.py plan',
                    summary=lambda o: f'{len(o["dimensions"])} dimensions x {len(o["cities"])} cities')

    def researcher(d):
        return lambda: demo.run(f'researcher-{d}', 'research-team', f'python3 -u agent.py research {d}',
                                summary=lambda o: f'{len(o["notes"])} figures in {o["steps"]} steps')

    found = demo.parallel([(f'researcher-{d}', researcher(d)) for d in plan['dimensions']])
    checked = demo.run('fact-checker', 'research-review', 'python3 -u agent.py check', found,
                       summary=lambda o: f'{o["checked"] - len(o["flags"])}/{o["checked"]} supported, {len(o["flags"])} stale')

    def reviser(f):
        return lambda: demo.run(f'revise-{f["dimension"]}-{f["city"].lower()}', 'research-team',
                                f'python3 -u agent.py revise {f["dimension"]} {f["city"]}', {'flag': f},
                                summary=lambda o: f'{f["old"]} -> {o["note"]["value"]}')

    revised = demo.parallel([(f'revise-{f["dimension"]}-{f["city"].lower()}', reviser(f)) for f in checked['flags']])
    out = demo.run('report-writer', 'research-report', 'python3 -u agent.py write', {**found, **revised}, live=True)
    demo.log('★', f'done in {time.time() - demo.start:.0f}s; report-writer is serving /workspace/report.md\n')
    print(out['report'])


def make(scope):
    return axdemo.Demo(scope, pathlib.Path(__file__).with_name('research'), WORKSPACES,
                       lambda n: n in FIXED or n.startswith('revise-'))


if __name__ == '__main__':
    axdemo.main(__doc__, make, run)
