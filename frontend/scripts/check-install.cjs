// Run from frontend: node scripts/check-install.cjs
const fs=require('node:fs'), Module=require('node:module'), ts=require('typescript');
const React=require('react'), {renderToStaticMarkup}=require('react-dom/server');
const assert=require('node:assert/strict');
const original=Module.prototype.require;
let states=[], cursor=0, effects=[];
const listeners={};
Object.defineProperty(global,'navigator',{value:{userAgent:'Android Mobile'},configurable:true});
global.window={addEventListener:(name,fn)=>listeners[name]=fn,removeEventListener:()=>{},matchMedia:()=>({matches:false})};
Module.prototype.require=function(name){
  if(name==='react') return {...React,useState:initial=>{const index=cursor++;if(!(index in states))states[index]=initial;return [states[index],value=>states[index]=value]},useEffect:fn=>effects.push(fn),useCallback:fn=>fn};
  return original.call(this,name);
};
function load(path){const module=new Module(__filename);module.paths=Module._nodeModulePaths(process.cwd());module._compile(ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{jsx:4,module:1,target:9}}).outputText,__filename);return module.exports;}
async function main(){
  const {useInstallPrompt}=load('src/hooks/useInstallPrompt.ts');
  const render=()=>{cursor=0;return useInstallPrompt()};
  render();effects.splice(0).forEach(fn=>fn());
  let prevented=0,prompted=0;
  listeners.beforeinstallprompt({preventDefault:()=>prevented++,prompt:async()=>prompted++,userChoice:Promise.resolve({outcome:'accepted'})});
  const hook=render();assert.equal(hook.show,true);assert.equal(prevented,1);assert.equal(prompted,0);
  await hook.promptInstall();assert.equal(prompted,1);assert.equal(render().installed,true);
  let show=true;
  Module.prototype.require=function(name){if(name==='@/hooks/useInstallPrompt')return {useInstallPrompt:()=>({show,installed:false,promptInstall:()=>{}})};return original.call(this,name)};
  const {InstallPrompt}=load('src/components/layout/InstallPrompt.tsx');
  const markup=renderToStaticMarkup(React.createElement(InstallPrompt));
  assert.ok(markup.includes('Install PropAI (optional)'));assert.ok(!markup.includes('fixed'));assert.ok(!markup.includes('Not now'));
  show=false;assert.equal(renderToStaticMarkup(React.createElement(InstallPrompt)),'');
  assert.ok(!fs.readFileSync('src/app/layout.tsx','utf8').includes('<InstallPrompt'));
  assert.ok(fs.readFileSync('src/components/layout/MobileDrawer.tsx','utf8').includes('<InstallPrompt />'));
  console.log('PASS: install event deferred without prompting; explicit action works; installed state hides action; no global overlay; menu action only.');
}
main().finally(()=>Module.prototype.require=original);
