"""Analyses over the district simulations. INPUT maps district task names to their output.

    python3 analyze.py demand | surge | equity
"""
import json
import os
import sys
import time

# Columns of a tick row, as written by sim.py.
T, REQ, SERVED, WAITING, CANCELLED, ABANDONED, SURGE, ONLINE, REVENUE, WAIT = range(10)


def clock(t):
    return f'{t // 2:02d}:{30 * (t % 2):02d}'


def say(kind, msg):
    print(f'[analyze-{kind}] {msg}', flush=True)
    time.sleep(0.6)


def demand(sims):
    rows, city = [], [0] * 48
    for s in sims:
        ticks = s['ticks']
        req = sum(x[REQ] for x in ticks)
        peak = max(ticks, key=lambda x: x[REQ])
        for x in ticks:
            city[x[T]] += x[REQ]
        rows.append([s['district'], req, f'{sum(x[SERVED] for x in ticks) / req:.0%}', clock(peak[T]), f'${sum(x[REVENUE] for x in ticks) / 100:,.0f}'])
        say('demand', f'{s["district"]}: {req} requests, peak at {clock(peak[T])}')
    rows.sort(key=lambda r: -r[1])
    peak = max(range(48), key=lambda t: city[t])
    return {
        'title': 'Demand', 'columns': ['district', 'requests', 'served', 'peak', 'revenue'], 'rows': rows,
        'headline': f'Citywide demand peaks at {clock(peak)} with {city[peak]} requests in half an hour; {rows[0][0]} is busiest.',
    }


def surge(sims):
    rows = []
    for s in sims:
        ticks = s['ticks']
        hot = sum(x[SURGE] >= 2 for x in ticks) / 2
        worst = max(ticks, key=lambda x: x[SURGE])
        rows.append([s['district'], f'{sum(x[SURGE] for x in ticks) / len(ticks):.2f}x', f'{worst[SURGE]:.1f}x at {clock(worst[T])}', f'{hot:g} h'])
        say('surge', f'{s["district"]}: {hot:g} hours at 2x or more')
    rows.sort(key=lambda r: -float(r[3].split()[0]))
    calm = rows[-1][0]
    return {
        'title': 'Surge', 'columns': ['district', 'avg surge', 'peak', 'time at 2x+'], 'rows': rows,
        'headline': f'{rows[0][0]} spends {rows[0][3]} at 2x or more; {calm} barely surges.',
        'worst': rows[0][0], 'calm': calm,
    }


def equity(sims):
    tiers = {}
    for s in sims:
        t = tiers.setdefault(s['income'], {'req': 0, 'served': 0, 'lost': 0, 'n': []})
        for x in s['ticks']:
            t['req'] += x[REQ]
            t['served'] += x[SERVED]
            t['lost'] += x[CANCELLED] + x[ABANDONED]
        t['n'].append(s['district'])
        say('equity', f'{s["district"]} -> income tier {s["income"]}')
    names = {1: 'lower', 2: 'middle', 3: 'higher'}
    rows = [[names[k], ', '.join(v['n']), f'{v["lost"] / v["req"]:.0%}', f'{v["served"] / v["req"]:.0%}']
            for k, v in sorted(tiers.items())]
    return {
        'title': 'Equity', 'columns': ['income', 'districts', 'riders lost', 'served'], 'rows': rows,
        'headline': f'Lower-income districts lose {rows[0][2]} of riders to price or waiting, against {rows[-1][2]} in higher-income ones.',
    }


if __name__ == '__main__':
    kind = sys.argv[1]
    sims = sorted(json.loads(os.environ['INPUT']).values(), key=lambda s: s['district'])
    say(kind, f'reading {len(sims)} district simulations')
    out = {'demand': demand, 'surge': surge, 'equity': equity}[kind](sims)
    say(kind, out['headline'])
    with open('out.tmp', 'w') as f:
        json.dump(out, f)
    os.replace('out.tmp', 'out.json')
