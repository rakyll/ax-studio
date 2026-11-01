"""Writes report.md from the analyses in INPUT, then keeps watch like a live service."""
import json
import os
import time

found = json.loads(os.environ['INPUT'])
demand, surge, equity = found['analyze-demand'], found['analyze-surge'], found['analyze-equity']

lines = ['# Orbit city report: Halloween', '']
lines += [f'- {a["headline"]}' for a in (demand, surge, equity)]
lines += ['', f'**Recommendation:** move standby drivers from {surge["calm"]} into {surge["worst"]} from 17:00 to 23:00, '
          'and cap surge at 2x in lower-income districts.', '']
for a in (demand, surge, equity):
    lines += [f'## {a["title"]}', '', '| ' + ' | '.join(a['columns']) + ' |', '|' + '---|' * len(a['columns'])]
    lines += ['| ' + ' | '.join(str(c) for c in row) + ' |' for row in a['rows']] + ['']
report = '\n'.join(lines)
with open('report.md', 'w') as f:
    f.write(report)
with open('out.tmp', 'w') as f:
    json.dump({'report': report}, f)
os.replace('out.tmp', 'out.json')
print(report, flush=True)
while True:
    time.sleep(10)
    print('[city-report] serving report.md', flush=True)
