"""Одноразовый согласованный прогон Opus, без расписаний и повторов POST."""
import os, sys, json, re, time, fcntl
from pathlib import Path
from datetime import datetime, timezone
from dotenv import dotenv_values
ROOT = Path('/home/user/Qwen2API/deploy/novelbins-hourly/opus-20261103')
lock = open(ROOT / 'lock', 'w')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
os.environ['DATABASE_URL'] = dotenv_values('/home/user/novelbins-epub/.env')['DATABASE_URL']
sys.path.insert(0, '/home/user/.claude/jobs/3c97346b/tmp/opus')
import run_tomato_batch as old
from app import db
from app.models import Chapter, Novel, AIModel, Translation
from sqlalchemy import text
svc = old.svc
STATE = ROOT / 'state.json'
def save(s):
    s['updated_at'] = datetime.now(timezone.utc).isoformat()
    p=STATE.with_suffix('.tmp');p.write_text(json.dumps(s,ensure_ascii=False,indent=2));p.replace(STATE)
def log(*args):
    print(datetime.now(timezone.utc).isoformat(), *args, flush=True)
def bound(reqs):
    # Text-only UTF-8 bytes deliberately overestimate input tokens, plus envelope allowance.
    return sum(((len(json.dumps(r['params'],ensure_ascii=False).encode('utf-8')) + 2048)*2 + r['params']['max_tokens']*10)/1e6 for r in reqs)
app=old.create_app()
with app.app_context():
    model=db.session.get(AIModel,50)
    assert model.model_id=='claude-opus-5-5' and svc.effort_for(model)=='low'
    assert svc.PRICES[model.model_id]==(4,20)
    if STATE.exists():
        s=json.loads(STATE.read_text())
        if s['phase']=='submitting': raise RuntimeError('Ambiguous POST: reconcile remote batches before restart')
    else:
        rows=db.session.execute(text('''WITH last AS (SELECT DISTINCT ON(chapter_id) chapter_id,api_used FROM translations WHERE translation_type='edited' ORDER BY chapter_id,id DESC) SELECT c.id,c.novel_id,c.chapter_number,c.original_text,t.api_used FROM chapters c LEFT JOIN last t ON t.chapter_id=c.id WHERE c.novel_id IN (23,24) AND c.status='aligned' ORDER BY c.novel_id,c.chapter_number''')).all()
        plan=[];counts={23:0,24:0}
        for cid,n,num,orig,api in rows:
            if len(re.findall(r'[\u4e00-\u9fff]',orig or ''))<800 or any(x in (api or '').lower() for x in ['anthropic','opus']):continue
            if n==24 and counts[n]>=300:continue
            plan.append({'id':cid,'novel':n,'number':num});counts[n]+=1
        assert counts=={23:804,24:300}, counts
        # Existing uncollected batches must not overlap this plan.
        ids={str(x['id']) for x in plan}
        for m in svc.list_batches():
            if not m.get('collected') and ids.intersection(m.get('chapters',{})):
                raise RuntimeError('Existing uncollected overlapping batch '+m['batch_id'])
        for n in (23,24):
            novel=db.session.get(Novel,n)
            assert not novel.editing_task_id, (n,'active editing task')
        s={'phase':'prepared','budget':100.0,'spent':0.0,'offset':0,'plan':plan,'batches':[],'deadline':'2026-11-04T00:00:00+00:00'}
        save(s);log('PREPARED',counts,'model',model.model_id,'max_tokens',model.max_output_tokens)
    if '--prepare' in sys.argv:sys.exit(0)
    while s['offset']<len(s['plan']):
        if s['phase']=='waiting':
            bid=s['active_batch'];meta=svc.load_meta(bid)
            if not meta.get('collected'):
                meta=svc.refresh_status(bid)
                if meta['processing_status']!='ended':
                    log('WAIT',bid,meta.get('request_counts'));db.session.remove();time.sleep(60);continue
                meta=svc.collect_translation_batch(bid)['meta']
            cost=meta['cost_usd_estimate']
            # No retries: failed chapters are recorded for expert review.
            qa=[]
            for item in s['active_chapters']:
                t=Translation.query.filter_by(chapter_id=item['id'],translation_type='edited').order_by(Translation.id.desc()).first()
                if not t or (t.context_used or {}).get('batch_id')!=bid:continue
                tx=t.translated_text or '';cjk=len(re.findall(r'[\u4e00-\u9fff]',tx))
                ch=db.session.get(Chapter,item['id']);orig=ch.original_text or ''
                lines=[x.strip() for x in tx.splitlines() if len(x.strip())>100]
                if cjk>20 or len(tx)<len(orig)*1.2 or len(lines)-len(set(lines))>2:
                    qa.append({'chapter':item['number'],'cjk':cjk,'length':len(tx),'original_length':len(orig)})
            entry={'id':bid,'novel':meta['novel_id'],'cost':cost,'report':meta['report'],'qa_candidates':qa}
            s['batches'].append(entry);s['spent']=round(s['spent']+cost,6)
            s['offset']+=len(s['active_chapters']);s['phase']='ready';save(s)
            log('COLLECTED',bid,'cost',cost,'spent',s['spent'],'offset',s['offset'],'qa',len(qa),'failed',len(meta['report']['failed']))
            if qa or meta['report']['failed']:
                s['phase']='quality_review_required';save(s);break
        if s['offset']==len(s['plan']):break
        if s['phase'] not in ('prepared','ready'):break
        if datetime.now(timezone.utc)>=datetime.fromisoformat(s['deadline']):
            s['phase']='deadline_stop';save(s);break
        remaining=99.5-s['spent']  # additional $0.50 reserve
        chosen=[];cached={};reserve=0;novel_id=s['plan'][s['offset']]['novel']
        if db.session.get(Novel,novel_id).editing_task_id:raise RuntimeError('Concurrent editing task')
        for item in s['plan'][s['offset']:]:
            if item['novel']!=novel_id or len(chosen)>=120:break
            ch=db.session.get(Chapter,item['id'])
            if ch.status!='aligned':raise RuntimeError('Chapter changed since plan '+str(item))
            reqs=svc.build_chapter_requests(ch,model)
            b=bound(reqs)
            if reserve+b>remaining:break
            chosen.append(item);cached[ch.id]=reqs;reserve+=b
        if not chosen:
            s['phase']='budget_stop';save(s);break
        s.update(phase='submitting',active_chapters=chosen,reserved_upper_usd=reserve);save(s)
        original=svc.build_chapter_requests
        svc.build_chapter_requests=lambda ch,model:cached[ch.id]
        try:meta=svc.submit_translation_batch([x['id'] for x in chosen],50,'edited')
        finally:svc.build_chapter_requests=original
        s.update(phase='waiting',active_batch=meta['batch_id']);save(s)
        log('SUBMITTED',meta['batch_id'],'N',novel_id,'chapters',len(chosen),'reserve',round(reserve,4),'spent',s['spent'])
    if s['offset']==len(s['plan']):s['phase']='complete';save(s)
    log('STOP',s['phase'],'spent',s['spent'],'processed',s['offset'])
