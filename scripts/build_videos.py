#!/usr/bin/env python3
"""Encode phone copies + posters for Swipe Room and write app/videos.json.
Sources: old Ranking Room manifest (129 videos) + /mnt/project-files/series/<slug>/*.mp4.
Re-runnable: skips outputs that exist and are newer than their source."""
import json, os, subprocess, sys, glob, re
from concurrent.futures import ThreadPoolExecutor

PF = '/mnt/project-files/'
APP = '/home/user/swipe/app'
os.makedirs(f'{APP}/v', exist_ok=True); os.makedirs(f'{APP}/p', exist_ok=True)
man = json.load(open(PF + 'rating-app/source/manifest.json'))
SERIES = {'tiny-cause': 'Tiny Cause', 'from-scratch': 'From Scratch', 'on-purpose': 'On Purpose',
          'youve-built-a': "You've Built A", 'con-chain': 'Con Chain', 'second-act': 'Second Act',
          'you-and-nia': 'You and Nia', 'bigger-worth-less': 'Bigger Worth Less',
          'earnings-decoded': 'Earnings Decoded', 'time-machine': 'Time Machine'}

def dur(src):
    try:
        return round(float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src]).decode().strip()))
    except Exception:
        return 0

items = []
cats = [c for c in man['cats']]
# series first (newest format), then dynasty, then the rest in old order
series_items = []
for slug, label in SERIES.items():
    for src in sorted(glob.glob(f'{PF}series/{slug}/*.mp4')):
        stem = os.path.basename(src)[:-4]
        if re.search(r'(thumb|tmp|draft|preview|test)', stem):
            continue
        m = re.match(r'(\d+)-(.*)', stem)
        ep = int(m.group(1)) if m else 0
        title = (m.group(2) if m else stem).replace('-', ' ').strip().capitalize()
        series_items.append(dict(id=f'{slug}-{stem}', cat=slug, title=f'{label} {ep}: {title}', hook='', src=src,
                                 series=label, ep=ep, thumb=src[:-4] + '-thumb-vertical.png'))
        if [slug, label] not in cats:
            cats.insert(0, [slug, label])
old = []
for v in man['videos']:
    base = (PF + v['t']) if v.get('t') else v['src'][:-4]
    old.append(dict(id=v['id'], cat=v['cat'], title=v['title'], hook=v.get('hook', ''), src=v['src'],
                    thumb=base + '-thumb-vertical.png',
                    **({'series': 'The Untaxable Dynasty', 'ep': int(v['id'].split('-')[1])} if v['cat'] == 'dynasty' else {})))
dyn = [x for x in old if x['cat'] == 'dynasty']
items = series_items + dyn + [x for x in old if x['cat'] != 'dynasty']

def fresh(out, src):
    return os.path.exists(out) and os.path.getsize(out) > 0 and os.path.getmtime(out) >= os.path.getmtime(src)

def enc(it):
    src, vid = it['src'], it['id']
    out = f'{APP}/v/{vid}.mp4'; po = f'{APP}/p/{vid}.jpg'
    if not fresh(out, src):
        tmp = out + '.tmp.mp4'
        r = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', src,
                            '-vf', 'scale=540:960:flags=lanczos,format=yuv420p',
                            '-c:v', 'libx264', '-profile:v', 'main', '-level', '3.1', '-preset', 'slow', '-threads', '2',
                            '-crf', '25', '-maxrate', '420k', '-bufsize', '840k', '-g', '60',
                            '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '2',
                            '-movflags', '+faststart', tmp])
        if r.returncode != 0:
            return vid, 'ENCODE FAIL'
        os.replace(tmp, out)
    if not fresh(po, src):
        if os.path.exists(it['thumb']):
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', it['thumb'], '-vf', 'scale=540:960', '-q:v', '4', po])
        else:
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', '3', '-i', src, '-frames:v', '1', '-vf', 'scale=540:960', '-q:v', '4', po])
    return vid, 'ok'

jobs = int(sys.argv[1]) if len(sys.argv) > 1 else 2
with ThreadPoolExecutor(jobs) as ex:
    for vid, st in ex.map(enc, items):
        print(st, vid, flush=True)

out = []
for it in items:
    if not os.path.exists(f'{APP}/v/{it["id"]}.mp4'):
        continue
    e = dict(id=it['id'], cat=it['cat'], title=it['title'], hook=it['hook'], dur=dur(f'{APP}/v/{it["id"]}.mp4'),
             v=f'v/{it["id"]}.mp4', p=f'p/{it["id"]}.jpg', w=540, h=960)
    if it.get('series'):
        e['series'] = it['series']; e['ep'] = it['ep']
    out.append(e)
used = {e['cat'] for e in out}
json.dump({'version': '2026-11-23', 'cats': [c for c in cats if c[0] in used], 'videos': out},
          open(f'{APP}/videos.json', 'w'), indent=1, ensure_ascii=False)
tot = sum(os.path.getsize(f'{APP}/{e["v"]}') for e in out)
print(f'DONE {len(out)} videos, {tot/1e6:.0f} MB')
