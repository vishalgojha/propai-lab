"""Bounded temporary container swap. Candidate images must already pass gates.

No durable Coolify config edits. Originals remain stopped with their exact writable
layers. Restore deletes the temporary clones, renames/starts exact originals.
No secret/environment values are printed. This script owns no app requests.
"""
import argparse,copy,fcntl,http.client,json,os,pathlib,socket,subprocess,sys,time
ROOT=pathlib.Path('/tmp/propai-timing-20261120')
STATE=ROOT/'swap-state.json'
BASES=[('api','djbbkdp28uhoc5p8cfnjr642-125222009514','sha256:fe1b85883227ca7e6ec42e3f7c0421f0f800b99f09af990d5819f39acffbe3f4'),('ui','y18kprfw29mu6wclzgpgfrvv-151253377751','sha256:4164d7f03da4b829046e20029f9cdd9ea66e54aff6e7a64a3f1553e0a88d0d63')]
class Unix(http.client.HTTPConnection):
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.connect('/var/run/docker.sock')
def engine(method,path,data=None):
    c=Unix('localhost',timeout=90);body=None if data is None else json.dumps(data)
    c.request(method,'/v1.47'+path,body,{'Content-Type':'application/json'})
    r=c.getresponse();raw=r.read();c.close()
    if r.status>=400:raise RuntimeError('Docker operation failed '+str(r.status)+' '+path)
    return json.loads(raw) if raw else None
def info(name):return engine('GET','/containers/'+name+'/json')
def envmap(x):return dict(v.split('=',1) for v in x['Config']['Env'] if '=' in v)
def save(s):
    tmp=STATE.with_suffix('.tmp');tmp.write_text(json.dumps(s));os.chmod(tmp,0o600);tmp.replace(STATE)
def snapshot():
    if STATE.exists():raise RuntimeError('Existing state must be reconciled before a new run')
    rows=[]
    for role,name,image in BASES:
        x=info(name)
        if x['Image']!=image or not x['State']['Running']:raise RuntimeError('Baseline changed '+role)
        if role=='api' and envmap(x).get('BROKER_PROPERTY_CROSS_SEARCH_ENABLED','').lower()!='false':raise RuntimeError('Sharing must stay off')
        rows.append({'role':role,'name':name,'image':image,'backup':name+'-timing-original','original':x})
    m=info('j56x1pgkvb985wh8bmkfr0hj-125249144694')
    if envmap(m).get('BROKER_PROPERTY_CROSS_SEARCH_ENABLED','').lower()!='false':raise RuntimeError('MCP sharing must stay off')
    s={'rows':rows,'status':'prepared','run':os.urandom(8).hex()};save(s);print('PREPARED exact baselines, sharing OFF')
def restore():
    with (ROOT/'restore.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        for attempt in range(3):
            try:return _restore()
            except Exception as exc:
                print('Restore attempt failed',attempt+1,type(exc).__name__,flush=True)
                if attempt==2:raise
                time.sleep(3)
def _restore():
    if not STATE.exists():raise RuntimeError('No state')
    s=json.loads(STATE.read_text())
    # Each step is reconciled from current Docker state, including interruption.
    for row in reversed(s['rows']):
        name,backup=row['name'],row['backup']
        try:original=info(backup)
        except RuntimeError:
            original=info(name)
            if original['Id']!=row['original']['Id']:raise RuntimeError('Cannot locate original '+row['role'])
            if not original['State']['Running']:engine('POST','/containers/'+name+'/start')
            continue
        try:current=info(name)
        except RuntimeError:current=None
        if current:
            try:
                raw=subprocess.run(['docker','logs',name],capture_output=True,text=True,check=True)
                clean=[]
                for line in (raw.stdout+'\n'+raw.stderr).splitlines():
                    if 'correlated_timing ' not in line:continue
                    try:record=json.loads(line.split('correlated_timing ',1)[1])
                    except (ValueError,IndexError):continue
                    allowed={'trace','path','pid','stage','wall_ms','elapsed_ms','status','body_sent','outcome'}
                    if set(record)<=allowed:clean.append(record)
                (ROOT/(row['role']+'-capture.json')).write_text(json.dumps(clean))
            except Exception:
                print('Capture collection failed; restoring regardless',flush=True)
            if current['Config']['Labels'].get('propai.timing.run')!=s['run']:raise RuntimeError('Refuse unrelated container removal')
            engine('DELETE','/containers/'+name+'?force=true')
        engine('POST','/containers/'+backup+'/rename?name='+name)
        engine('POST','/containers/'+name+'/start')
    s['status']='restored';save(s)
    for row in s['rows']:
        x=info(row['name'])
        if x['Id']!=row['original']['Id'] or x['Image']!=row['image'] or not x['State']['Running']:raise RuntimeError('Restore verification failed')
    print('RESTORED exact original container IDs/images')
def activate():
    s=json.loads(STATE.read_text())
    if s['status']!='prepared':raise RuntimeError('Not a prepared run')
    deadline=int(time.time())+180;s.update(status='activating',deadline=deadline);save(s)
    # Detached watchdog is armed before first stop. Always restores, even if
    # parent/browser disappears. It does not make app requests or retry capture.
    subprocess.Popen([sys.executable,__file__,'watchdog'],stdin=subprocess.DEVNULL,stdout=open(ROOT/'restore-watchdog.log','a'),stderr=subprocess.STDOUT,start_new_session=True)
    try:
        for row in s['rows']:
            if time.time()>deadline-40:raise RuntimeError('Insufficient bounded window')
            x=info(row['name'])
            if x['Id']!=row['original']['Id']:raise RuntimeError('Baseline changed before stop')
            engine('POST','/containers/'+row['name']+'/stop?t=10')
            engine('POST','/containers/'+row['name']+'/rename?name='+row['backup'])
            config=copy.deepcopy(x['Config']);config['Image']='propai-timing-'+row['role']+':20261120'
            config['Labels']['propai.timing.run']=s['run']
            image=engine('GET','/images/'+config['Image']+'/json')
            config['Cmd']=image['Config']['Cmd'];config['Entrypoint']=image['Config']['Entrypoint']
            config['Env']=[v for v in config['Env'] if not v.startswith(('PROPAI_DIAG_RUN=','PROPAI_DIAG_UNTIL_MS='))]+['PROPAI_DIAG_RUN='+s['run'],'PROPAI_DIAG_UNTIL_MS='+str(deadline*1000)]
            config['HostConfig']=x['HostConfig']
            config['NetworkingConfig']={'EndpointsConfig':{n:{k:v for k,v in e.items() if k in ('Aliases','IPAMConfig','Links','DriverOpts') and v is not None} for n,e in x['NetworkSettings']['Networks'].items()}}
            new=engine('POST','/containers/create?name='+row['name'],config)
            if row['role']=='api':
                # Preserve generated baseline key without reading or printing it.
                # Missing source key is a blocker, not a reason to generate anew.
                p=ROOT/'preserved-api-key';subprocess.run(['docker','cp',row['backup']+':/app/.api_key',str(p)],check=True,stdout=subprocess.DEVNULL);os.chmod(p,0o600)
                try:subprocess.run(['docker','cp',str(p),row['name']+':/app/.api_key'],check=True,stdout=subprocess.DEVNULL)
                finally:p.unlink(missing_ok=True)
            engine('POST','/containers/'+row['name']+'/start')
            limit=min(deadline-20,time.time()+60)
            while time.time()<limit:
                state=info(row['name'])['State']
                if not state['Running']:raise RuntimeError('Candidate stopped')
                if state.get('Health',{}).get('Status')=='healthy':break
                if not state.get('Health'):
                    logs=subprocess.run(['docker','logs',row['name']],capture_output=True,text=True,check=True)
                    startup=logs.stdout+'\n'+logs.stderr
                    if row['role']=='api' and startup.count('Application startup complete.')>=4:break
                    if row['role']=='ui' and 'Ready in' in startup:break
                time.sleep(2)
            else:raise RuntimeError('Startup health deadline')
            if row['role']=='api':
                check=['docker','exec',row['name'],'python','-c',
                       "import urllib.request; r=urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=8); assert r.status==200"]
            else:
                check=['docker','exec',row['name'],'node','-e',
                       "fetch('http://127.0.0.1:3000/auth/login',{signal:AbortSignal.timeout(8000)}).then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))"]
            subprocess.run(check,check=True,stdout=subprocess.DEVNULL,timeout=12)
        s['status']='ready';save(s);print(json.dumps({'status':'ready','run':s['run'],'deadline':deadline,'remaining_seconds':int(deadline-time.time())}))
    except BaseException:
        restore();raise

def watchdog():
    s=json.loads(STATE.read_text());time.sleep(max(0,s['deadline']-time.time()))
    if json.loads(STATE.read_text())['status']!='restored':restore()

if __name__=='__main__':
    os.umask(0o077);mode=sys.argv[1]
    if mode=='prepare':snapshot()
    elif mode=='activate':activate()
    elif mode=='restore':restore()
    elif mode=='watchdog':watchdog()
    else:raise ValueError('unknown mode')
