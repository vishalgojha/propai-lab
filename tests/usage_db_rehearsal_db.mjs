// Disposable PGlite PostgreSQL server for usage rehearsal. No production URLs.
import fs from 'node:fs';
const {PGlite}=await import(process.env.PGLITE_MODULE);
const {PGLiteSocketServer}=await import(process.env.PGLITE_SOCKET_MODULE);
const db=await PGlite.create();
await db.exec(fs.readFileSync(process.argv[2],'utf8'));
const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:55431});
await server.start();
console.log('READY local PostgreSQL');
process.on('SIGTERM',async()=>{await server.stop();await db.close();process.exit(0);});
