"""Agents for the AX city demo. Each step reads INPUT (JSON) and writes out.json.

    python3 sim.py plan | weather | events | district <name>
"""
import json
import math
import os
import random
import sys
import time

TICKS = 48  # half-hour ticks over one day


def save(obj):
    with open('out.tmp', 'w') as f:
        json.dump(obj, f, separators=(',', ':'))
    os.replace('out.tmp', 'out.json')


def say(who, msg):
    print(f'[{who}] {msg}', flush=True)


def clock(t):
    return f'{t // 2:02d}:{30 * (t % 2):02d}'


def plan():
    say('city-planner', 'zoning six districts')
    city = {
        'mission': {'residents': 900, 'drivers': 60, 'income': 2, 'nightlife': 0.8},
        'soma': {'residents': 700, 'drivers': 70, 'income': 3, 'nightlife': 0.6},
        'marina': {'residents': 600, 'drivers': 45, 'income': 3, 'nightlife': 0.5},
        'sunset': {'residents': 1000, 'drivers': 40, 'income': 1, 'nightlife': 0.1},
        'castro': {'residents': 500, 'drivers': 35, 'income': 2, 'nightlife': 0.9},
        'richmond': {'residents': 800, 'drivers': 38, 'income': 1, 'nightlife': 0.2},
    }
    for name, d in city.items():
        time.sleep(0.4)
        say('city-planner', f'{name:<9} {d["residents"]:>5} residents  {d["drivers"]:>3} drivers  income tier {d["income"]}')
    save({'seed': 42, 'districts': city})


def weather():
    rng = random.Random(7)
    rain = [0.0] * TICKS
    for t in range(TICKS):
        storm = math.exp(-((t - 35) ** 2) / 12)  # a storm rolls in around 17:30
        rain[t] = round(min(1.0, storm + rng.uniform(0, 0.08)), 2)
        if t % 8 == 7:
            time.sleep(0.5)
            say('weather-agent', f'{clock(t - 7)}-{clock(t)} rain {max(rain[t - 7:t + 1]):.0%}')
    save({'rain': rain})


def events():
    found = [
        {'name': 'Giants game lets out', 'district': 'soma', 'tick': 43, 'crowd': 600},
        {'name': 'Halloween parade', 'district': 'castro', 'tick': 40, 'crowd': 500},
        {'name': 'Farmers market', 'district': 'marina', 'tick': 20, 'crowd': 150},
    ]
    for e in found:
        time.sleep(0.8)
        say('events-agent', f'{e["name"]} in {e["district"]} at {clock(e["tick"])} (~{e["crowd"]} people)')
    save({'events': found})


class Rider:
    __slots__ = ('budget', 'waited')

    def __init__(self, budget):
        self.budget = budget  # highest surge this rider accepts
        self.waited = 0


class Driver:
    __slots__ = ('online', 'busy')

    def __init__(self, online):
        self.online = online
        self.busy = 0


def demand(t, nightlife):
    hour = t / 2
    peaks = math.exp(-((hour - 8.5) ** 2) / 2) + 1.2 * math.exp(-((hour - 18) ** 2) / 3)
    night = nightlife * 1.5 * math.exp(-((hour - 22.5) ** 2) / 2)
    return 0.004 + 0.02 * (peaks + night)


def district(name):
    data = json.loads(os.environ['INPUT'])
    d = data['city-planner']['districts'][name]
    rain = data['weather-agent']['rain']
    crowds = [e for e in data['events-agent']['events'] if e['district'] == name]
    rng = random.Random(f'{name}-42')
    pace = float(os.environ.get('PACE', '0.2'))

    drivers = [Driver(online=i < d['drivers'] * 0.7) for i in range(d['drivers'])]
    queue, ticks = [], []
    lo, hi = {1: (1.0, 1.5), 2: (1.2, 2.4), 3: (1.6, 3.5)}[d['income']]
    say(name, f'{d["residents"]} rider agents, {d["drivers"]} driver agents')
    for t in range(TICKS):
        rate = demand(t, d['nightlife']) * (1 + 0.9 * rain[t])
        new = sum(rng.random() < rate for _ in range(d['residents']))
        for e in crowds:
            if e['tick'] <= t < e['tick'] + 3:
                new += e['crowd'] // 6
        idle = [x for x in drivers if x.online and x.busy == 0]
        surge = round(min(3.0, max(1.0, (len(queue) + new) / (len(idle) + 1))), 2)
        riders = [Rider(rng.uniform(lo, hi)) for _ in range(new)]
        accepted = [r for r in riders if r.budget >= surge]
        cancelled = len(riders) - len(accepted)
        queue.extend(accepted)

        served, waits = 0, 0
        for drv in idle:
            if not queue:
                break
            r = queue.pop(0)
            drv.busy = rng.randint(1, 2)
            served += 1
            waits += r.waited
        for r in queue:
            r.waited += 1
        abandoned = sum(r.waited > 3 for r in queue)
        queue = [r for r in queue if r.waited <= 3]

        # Drivers decide: surge pulls offline drivers in, a quiet district sends some home.
        for drv in drivers:
            if drv.busy:
                drv.busy -= 1
            elif not drv.online and surge >= 1.8 and rng.random() < 0.35:
                drv.online = True
            elif drv.online and surge <= 1.0 and rng.random() < 0.06:
                drv.online = False
        online = sum(x.online for x in drivers)
        fare = 600 + rng.randint(0, 900)
        ticks.append([t, new, served, len(queue), cancelled, abandoned, surge, online, int(served * fare * surge), round(waits / served, 2) if served else 0])
        if t % 6 == 5 or (crowds and any(e['tick'] == t for e in crowds)):
            say(name, f'{clock(t)}  requests {new:>3}  served {served:>3}  waiting {len(queue):>3}  surge {surge:.1f}x  drivers {online}')
        time.sleep(pace)
    save({'district': name, 'income': d['income'], 'ticks': ticks})
    say(name, f'day done: {sum(x[2] for x in ticks)} rides, {sum(x[4] + x[5] for x in ticks)} riders lost')


if __name__ == '__main__':
    step = sys.argv[1]
    {'plan': plan, 'weather': weather, 'events': events}.get(step, lambda: district(sys.argv[2]))()
