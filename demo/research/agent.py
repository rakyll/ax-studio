"""Research agents for the AX demo, working over an offline corpus.

    python3 agent.py plan | research <dimension> | check | revise <dimension> <city> | write

Each step reads INPUT (JSON), prints its trajectory, appends it to trajectory.jsonl
and writes its result to out.json.
"""
import json
import os
import random
import re
import sys
import time

QUESTION = 'Where should Orbit launch next: Lisbon, Austin, Seoul or Nairobi?'
CITIES = ['Lisbon', 'Austin', 'Seoul', 'Nairobi']

# dimension: label, search words, title, sentence, extraction pattern, whether higher is better
DIMENSIONS = {
    'demand': ('weekly ride-hail trips per 1,000 residents', 'ride-hail trips residents survey',
               '{c} mobility survey {y}', 'Residents of {c} took {v} ride-hail trips per 1,000 residents each week.',
               r'took (\d+) ride-hail trips', True),
    'regulation': ('weeks to get an operating permit', 'ride-hail permit wait weeks operators',
                   '{c} ride-hail permit rules ({y})', 'New ride-hail operators in {c} wait about {v} weeks for a permit.',
                   r'wait about (\d+) weeks', False),
    'competition': ("market leader's share of trips", 'ride-hail market share leading operator',
                    '{c} ride-hail market report {y}', 'The leading ride-hail operator in {c} holds {v}% of trips.',
                    r'holds (\d+)% of trips', False),
    'economics': ('driver cost per hour in USD', 'driver cost hour earnings operators',
                  '{c} driver earnings study {y}', 'Drivers in {c} cost operators about ${v} per hour including incentives.',
                  r'about \$(\d+) per hour', False),
    'operations': ('public fast chargers per 100,000 residents', 'EV fast chargers residents charging census',
                   '{c} EV charging census {y}', '{c} has {v} public fast chargers per 100,000 residents.',
                   r'has (\d+) public fast chargers', True),
}
FACTS = {
    'demand': {'Lisbon': 41, 'Austin': 36, 'Seoul': 58, 'Nairobi': 33},
    'regulation': {'Lisbon': 6, 'Austin': 2, 'Seoul': 30, 'Nairobi': 4},
    'competition': {'Lisbon': 48, 'Austin': 71, 'Seoul': 88, 'Nairobi': 52},
    'economics': {'Lisbon': 11, 'Austin': 24, 'Seoul': 17, 'Nairobi': 4},
    'operations': {'Lisbon': 62, 'Austin': 38, 'Seoul': 120, 'Nairobi': 9},
}
# Older documents that outrank the current ones in search, with what changed since.
STALE = {
    ('regulation', 'Lisbon'): (26, 2024, 'Lisbon ride-hail permit moratorium: permit rules and permit queue ({y})',
                               'New ride-hail operators in {c} wait about {v} weeks for a permit while the permit moratorium lasts.'),
    ('economics', 'Austin'): (19, 2025, 'Austin driver earnings study {y}: driver cost per hour',
                              'Drivers in {c} cost operators about ${v} per hour including incentives, before the 2026 driver pay ordinance.'),
}
DECOYS = [
    ('{c} tram ridership {y}', 'Tram ridership in {c} rose this year as residents returned to offices; trips per line are listed.'),
    ('{c} bike-share annual report {y}', 'Bike-share operators in {c} logged record trips; residents favour e-bikes for short hops.'),
    ('{c} airport taxi rules {y}', 'Airport taxi operators in {c} follow separate permit rules and a fixed hourly rate.'),
]


def corpus():
    docs = []
    for d, (_, _, title, sentence, _, _) in DIMENSIONS.items():
        for c in CITIES:
            docs.append({'title': title.format(c=c, y=2026), 'year': 2026, 'text': sentence.format(c=c, v=FACTS[d][c])})
    for (d, c), (v, y, title, sentence) in STALE.items():
        docs.append({'title': title.format(c=c, y=y), 'year': y, 'text': sentence.format(c=c, v=v)})
    for c in CITIES:
        for title, text in DECOYS:
            docs.append({'title': title.format(c=c, y=2026), 'year': 2026, 'text': text.format(c=c)})
    random.Random(3).shuffle(docs)
    for i, doc in enumerate(docs, 1):
        doc['id'] = f'doc-{i:03d}'
    return docs


def words(s):
    return re.findall(r'[a-z0-9]+', s.lower())


def search(docs, query, k=3):
    q = set(words(query))
    scored = [(sum(w in q for w in words(d['title'])) * 2 + sum(w in q for w in words(d['text'])), d) for d in docs]
    return [d for s, d in sorted(scored, key=lambda x: -x[0]) if s > 0][:k]


class Trajectory:
    def __init__(self, who, pace):
        self.who, self.pace, self.step, self.ctx = who, pace, 0, 1800
        self.log = open('trajectory.jsonl', 'a')

    def __call__(self, kind, text, tokens=120):
        self.step += 1
        self.ctx += tokens
        print(f'[{self.who}] {self.step:03d} {kind:<7} {text}   · ctx {self.ctx / 1000:.1f}k', flush=True)
        self.log.write(json.dumps({'step': self.step, 'kind': kind, 'text': text, 'ctx': self.ctx}) + '\n')
        self.log.flush()
        time.sleep(self.pace * random.uniform(0.7, 1.3))


def save(obj):
    with open('out.tmp', 'w') as f:
        json.dump(obj, f)
    os.replace('out.tmp', 'out.json')


def find_fact(t, docs, d, c, query):
    """Searches, reads hits until one states the fact, and returns a note; None on a dead end."""
    hits = search(docs, query)
    t('search', f'"{query}" -> {len(hits)} hits', 40)
    for doc in hits:
        t('read', f'{doc["id"]} "{doc["title"]}"', len(doc['text']) // 3 + 60)
        m = re.search(DIMENSIONS[d][4], doc['text'])
        if m and c in doc['text']:
            return {'dimension': d, 'city': c, 'value': int(m.group(1)), 'doc': doc['id'], 'year': doc['year'], 'quote': doc['text']}
        t('think', f'{doc["id"]} is not about {DIMENSIONS[d][0]}; skipping', 50)
    return None


def plan():
    t = Trajectory('lead-planner', 0.5)
    t('think', f'Question: {QUESTION}', 200)
    t('think', 'A launch decision needs demand, regulation, competition, unit economics and EV operations', 160)
    for d, spec in DIMENSIONS.items():
        t('plan', f'researcher-{d}: {spec[0]} in each city', 80)
    t('plan', 'fact-checker verifies every cited figure; report-writer weighs the five equally', 90)
    save({'question': QUESTION, 'cities': CITIES, 'dimensions': list(DIMENSIONS)})


def research(d):
    label, keywords = DIMENSIONS[d][:2]
    t = Trajectory(f'researcher-{d}', 0.55)
    random.seed(d)
    docs = corpus()
    t('think', f'Goal: {label} for {", ".join(CITIES)}', 150)
    t('tool', f'corpus.open() -> {len(docs)} documents indexed', 80)
    notes = []
    for i, c in enumerate(CITIES):
        t('think', f'Next: {label} in {c}', 60)
        note = None
        if i % 2 == 1:  # a vague first query that runs into look-alike documents
            note = find_fact(t, docs, d, c, f'{c} residents trips')
            if not note:
                t('reflect', 'Dead end: too vague. Rephrase with the metric\'s own words', 80)
        if not note:
            note = find_fact(t, docs, d, c, f'{c} {keywords}')
        if note:
            t('note', f'{c}: {note["value"]} ({note["doc"]}, {note["year"]})', 70)
            notes.append(note)
        else:
            t('reflect', f'No source for {c}; leaving it out', 60)
        if i % 2 == 1:
            t('reflect', f'{len(notes)}/{len(CITIES)} cities done: ' + ', '.join(f'{n["city"]} {n["value"]}' for n in notes), 90)
    best = (max if DIMENSIONS[d][5] else min)(notes, key=lambda n: n['value'])
    t('answer', f'Best on {d}: {best["city"]} ({best["value"]}); {len(notes)} cited figures', 120)
    save({'dimension': d, 'notes': notes, 'steps': t.step})


def check():
    found = json.loads(os.environ['INPUT'])
    notes = [n for r in found.values() for n in r['notes']]
    t = Trajectory('fact-checker', 0.3)
    docs = corpus()
    t('think', f'Verifying {len(notes)} cited figures against every matching source', 150)
    flags = []
    for n in notes:
        d, c = n['dimension'], n['city']
        sources = [doc for doc in docs if c in doc['text'] and re.search(DIMENSIONS[d][4], doc['text'])]
        newest = max(sources, key=lambda doc: doc['year'])
        value = int(re.search(DIMENSIONS[d][4], newest['text']).group(1))
        if value == n['value']:
            t('verify', f'{d}/{c} = {n["value"]} supported by {newest["id"]} ({newest["year"]})', 60)
        else:
            t('flag', f'{d}/{c} = {n["value"]} cites {n["doc"]} ({n["year"]}), but {newest["id"]} ({newest["year"]}) says {value}', 110)
            flags.append({'dimension': d, 'city': c, 'old': n['value'], 'doc': n['doc']})
    t('answer', f'{len(notes) - len(flags)} supported, {len(flags)} stale; sending stale figures back for revision', 90)
    save({'checked': len(notes), 'flags': flags})


def revise(d, c):
    flag = json.loads(os.environ['INPUT'])['flag']
    t = Trajectory(f'revise-{d}-{c.lower()}', 0.6)
    docs = corpus()
    t('think', f'{d}/{c} = {flag["old"]} came from {flag["doc"]}, which a newer source contradicts', 140)
    t('think', 'Search for the most recent source and prefer it over older ones', 80)
    hits = sorted(search(docs, f'{c} {DIMENSIONS[d][1]} 2026', k=5), key=lambda doc: -doc['year'])
    t('search', f'"{c} {DIMENSIONS[d][1]} 2026" -> {len(hits)} hits, newest first', 40)
    for doc in hits:
        t('read', f'{doc["id"]} "{doc["title"]}"', len(doc['text']) // 3 + 60)
        m = re.search(DIMENSIONS[d][4], doc['text'])
        if m and c in doc['text']:
            note = {'dimension': d, 'city': c, 'value': int(m.group(1)), 'doc': doc['id'], 'year': doc['year'], 'quote': doc['text']}
            t('note', f'{c}: {flag["old"]} -> {note["value"]} ({doc["id"]}, {doc["year"]})', 70)
            break
    t('answer', f'Revised {d}/{c} to {note["value"]}', 60)
    save({'note': note})


def rank(notes):
    table = {c: {} for c in CITIES}
    for n in notes:
        table[n['city']][n['dimension']] = n['value']
    scores = {c: 0.0 for c in CITIES}
    for d, spec in DIMENSIONS.items():
        vals = [table[c][d] for c in CITIES]
        lo, hi = min(vals), max(vals)
        for c in CITIES:
            x = (table[c][d] - lo) / (hi - lo)
            scores[c] += x if spec[5] else 1 - x
    return table, sorted(CITIES, key=lambda c: -scores[c]), scores


def write():
    found = json.loads(os.environ['INPUT'])
    t = Trajectory('report-writer', 0.5)
    first = [n for k, r in found.items() if k.startswith('researcher-') for n in r['notes']]
    fixes = {(r['note']['dimension'], r['note']['city']): r['note'] for k, r in found.items() if k.startswith('revise-')}
    final = [fixes.get((n['dimension'], n['city']), n) for n in first]
    t('think', f'{len(first)} figures from five researchers, {len(fixes)} revised by fact-checking', 160)
    _, before, _ = rank(first)
    table, after, scores = rank(final)
    t('think', f'Unchecked ranking: {" > ".join(before)}', 80)
    t('think', f'Checked ranking:   {" > ".join(after)}', 80)
    steps = sum(r.get('steps', 0) for r in found.values())
    lines = [f'# {QUESTION}', '', f'**Recommendation: launch in {after[0]}**, then {after[1]}.', '',
             f'Five researchers took {steps} steps over the corpus; the fact-checker sent back {len(fixes)} stale figures.']
    if before[0] != after[0]:
        lines.append(f'Before fact-checking, the answer would have been {before[0]}.')
    lines += ['', '| city | score | ' + ' | '.join(DIMENSIONS) + ' |', '|---|---|' + '---|' * len(DIMENSIONS)]
    lines += [f'| {c} | {scores[c]:.2f} | ' + ' | '.join(str(table[c][d]) for d in DIMENSIONS) + ' |' for c in after]
    lines += ['', 'Corrections:'] + [f'- {d}/{c}: {fix["value"]} (was stale; now {fix["doc"]}, {fix["year"]})' for (d, c), fix in fixes.items()]
    report = '\n'.join(lines)
    t('write', f'report.md ({len(report)} chars)', len(report) // 4)
    with open('report.md', 'w') as f:
        f.write(report)
    save({'report': report, 'winner': after[0], 'before': before[0]})
    print(report, flush=True)
    while True:
        time.sleep(10)
        print('[report-writer] serving report.md', flush=True)


if __name__ == '__main__':
    cmd, args = sys.argv[1], sys.argv[2:]
    {'plan': plan, 'research': research, 'check': check, 'revise': revise, 'write': write}[cmd](*args)
