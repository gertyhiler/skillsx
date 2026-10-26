# /// script
# requires-python = ">=3.10"
# dependencies = ["Pillow==11.3.0"]
# ///
"""Render the captured CLI transcript. Requires ffmpeg and explicit font paths.

uv run scripts/demo/render.py --sans /path/font.ttf --mono /path/mono.ttf
No synthetic command output: only timing and presentation are added.
"""
import argparse
import json
import subprocess
import tempfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

parser = argparse.ArgumentParser()
parser.add_argument('--sans', required=True)
parser.add_argument('--mono', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
assets = root / 'docs/assets'
sans = lambda size: ImageFont.truetype(args.sans, size)
mono = ImageFont.truetype(args.mono, 21)
bg, panel, ink, muted, mint = '#0b1218', '#101b24', '#f4f8f6', '#95a9b7', '#7af0bd'

def mark(draw, x, y, size):
    def pts(points): return [(x+a*size, y+b*size) for a,b in points]
    for points in [[(.15,.15),(.5,.5),(.15,.85)],[(.85,.15),(.5,.5),(.85,.85)]]:
        draw.line(pts(points), fill=mint, width=max(3,round(size*.12)))
    draw.rectangle((x+size*.43,y+size*.43,x+size*.57,y+size*.57), fill=ink)

hero = Image.new('RGB', (1600, 600), bg)
d = ImageDraw.Draw(hero)
d.rounded_rectangle((1120,80,1510,520), radius=28, fill=panel)
for y,label in [(145,'REGISTRY'),(260,'SKILLS'),(375,'AGENTS')]:
    d.text((1170,y), label, font=sans(17), fill=mint)
    text = {'REGISTRY':'One source of truth','SKILLS':'Flat or categorized','AGENTS':'Links or copies'}[label]
    d.text((1170,y+36), text, font=sans(25), fill=ink)
mark(d, 85, 92, 90)
d.text((200,85),'SkillsX',font=sans(94),fill=ink)
d.text((90,265),'Every skill. Accounted for.',font=sans(61),fill=ink)
d.text((94,365),'One registry. Your skills. Your agents.',font=sans(32),fill=muted)
d.text((94,495),'NODE CLI  /  GIT-NATIVE  /  MIT',font=sans(21),fill=mint)
hero.save(assets/'hero.png', optimize=True)
social = hero.resize((1280,480))
canvas = Image.new('RGB',(1280,640),bg); canvas.paste(social,(0,80)); canvas.save(assets/'social.png',optimize=True)

events = json.loads((assets/'demo.json').read_text())['events']
frames, durations = [], []
lines = []
def frame(command, progress):
    im=Image.new('RGB',(1200,720),bg); d=ImageDraw.Draw(im)
    mark(d,34,27,34); d.text((85,22),'SkillsX',font=sans(34),fill=ink)
    d.text((35,79),'One registry. Your skills. Your agents.',font=sans(22),fill=muted)
    d.rounded_rectangle((24,128,1176,654),radius=16,fill=panel)
    for x,c in [(49,'#f07878'),(73,'#e8c576'),(97,mint)]: d.ellipse((x,151,x+10,161),fill=c)
    d.text((127,143),'skillsx / disposable demo',font=sans(17),fill=muted)
    visible=lines[-12:]
    for i,(text,color) in enumerate(visible): d.text((48,190+i*33),text,font=mono,fill=color)
    d.text((35,680),'REAL CLI OUTPUT · OFFLINE FIXTURE · PLAYBACK TIMING EDITED',font=sans(15),fill=muted)
    d.rectangle((24,649,24+int(1152*progress),653),fill=mint)
    return im

for i,event in enumerate(events):
    command='$ '+event['command']
    # Wrap terminal text without dropping or inventing any output.
    def add(text,color):
        for part in text.splitlines():
            while len(part)>85:
                lines.append((part[:85],color)); part=part[85:]
            lines.append((part,color))
    add(command,mint)
    frames.append(frame(command,i/len(events))); durations.append(700)
    if event['output']: add(event['output'],'#ffac98' if event.get('error') else ink)
    frames.append(frame(command,(i+1)/len(events))); durations.append(2100 if i<len(events)-1 else 4500)
frames[0].save(assets/'demo.gif',save_all=True,append_images=frames[1:],duration=durations,loop=0,optimize=True)
with tempfile.TemporaryDirectory(prefix='skillsx-render-') as temp:
    temp=Path(temp)
    # Constant frame rate makes the MP4 easy to play and seek everywhere.
    n=0
    for image,duration in zip(frames,durations):
        for _ in range(duration//100):
            image.save(temp/f'{n:05}.png'); n+=1
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-framerate','10','-i',str(temp/'%05d.png'),'-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',str(assets/'demo.mp4')],check=True)
frames[-1].save(assets/'demo-poster.png',optimize=True)
print('Rendered hero, social preview, GIF, MP4 and poster from actual CLI output.')
