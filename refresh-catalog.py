"""Refresh local metadata; never send skill bodies to a model."""
import pathlib,json,re,tomllib,datetime,sys,uuid
base=pathlib.Path(__file__).resolve().parent
home=pathlib.Path.home()/'.codex'
cfg=tomllib.loads((home/'config.toml').read_text(encoding='utf-8-sig'))
catalog=base/'.local/skill-catalog.json'
template=base/'skill-catalog.json'
old=json.loads((catalog if catalog.is_file() else template).read_text(encoding='utf-8'))
disabled={str(pathlib.Path(s['path']).resolve()).lower() for s in cfg.get('skills',{}).get('config',[]) if s.get('enabled') is False}
sources={s['path']:s['name'] for s in old['skills']}
for f in (home/'skills').rglob('SKILL.md'): sources.setdefault(f.as_posix(),f.parent.name)
for key,settings in cfg.get('plugins',{}).items():
    if not settings.get('enabled',False) or '@' not in key: continue
    plugin,market=key.rsplit('@',1)
    folder=home/'plugins/cache'/market/plugin
    if not folder.is_dir(): continue
    versions=sorted((f for f in folder.iterdir() if f.is_dir()),key=lambda f:tuple(int(n) for n in re.findall(r'\d+',f.name)),reverse=True)
    if versions:
        for f in (versions[0]/'skills').rglob('SKILL.md'): sources[f.as_posix()]=plugin+':'+f.parent.name
for root in sys.argv[1:]:
    for folder in [pathlib.Path(root)/'.agents/skills',pathlib.Path(root)/'.codex/skills']:
        if folder.is_dir():
            for f in folder.rglob('SKILL.md'): sources[f.as_posix()]=f.parent.name
result={};removed=0
for source,name in sources.items():
    f=pathlib.Path(source)
    if not f.is_file() or str(f.parent.resolve()).lower() in disabled: removed+=1;continue
    if '/plugins/cache/' in f.as_posix():
        parts=f.as_posix().split('/plugins/cache/')[1].split('/')
        if len(parts)>=2 and cfg.get('plugins',{}).get(parts[1]+'@'+parts[0],{}).get('enabled') is False: removed+=1;continue
    with f.open(encoding='utf-8-sig',errors='replace') as handle: head=handle.read(8192)
    match=re.search(r'^description:\s*(.*?)(?=^\w[\w-]*:|^---\s*$)',head,re.M|re.S)
    description=' '.join(match.group(1).strip().lstrip('>|- ').strip().strip('"\'').split())[:350] if match else ''
    if not description:
        description=next((s['description'] for s in old['skills'] if s['path']==source),'Read the skill trigger before applying.')
    result[name]={'name':name,'description':description,'path':f.as_posix(),'modifiedNs':f.stat().st_mtime_ns}
data={'source':'Refreshed supplied availability snapshot plus local skills and explicitly enabled cached plugins. App-only enablement may require a fresh availability snapshot.','refreshedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'skills':list(result.values())}
catalog.parent.mkdir(parents=True,exist_ok=True)
temp=catalog.with_suffix('.'+uuid.uuid4().hex+'.tmp');temp.write_text(json.dumps(data,indent=2,ensure_ascii=False)+'\n',encoding='utf-8');temp.replace(catalog)
print(json.dumps({'skills':len(result),'removed':removed,'refreshedAt':data['refreshedAt']}))
