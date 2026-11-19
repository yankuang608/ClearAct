// SPDX-License-Identifier: MIT
#!/usr/bin/env node
import {randomBytes} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {createClearActServer} from './http.ts';

const approvalToken=process.env.CLEARACT_APPROVAL_TOKEN||randomBytes(32).toString('base64url');
if(!process.env.CLEARACT_APPROVAL_TOKEN){
 const tokenPath=resolve(process.env.CLEARACT_APPROVAL_TOKEN_FILE||'work/approval-token');
 await mkdir(dirname(tokenPath),{recursive:true});await writeFile(tokenPath,approvalToken,{mode:0o600});
 console.error(`Human approval credential saved at ${tokenPath}. Do not pass it to the MCP/agent process.`);
}
const app=createClearActServer({approvalToken,allowedOrigins:process.env.CLEARACT_ALLOWED_ORIGINS?.split(',').filter(Boolean)});
const port=Number(process.env.CLEARACT_PORT||4310);
app.server.listen(port,'127.0.0.1',()=>console.error(`ClearAct broker listening at http://127.0.0.1:${port}`));
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>void app.close().then(()=>process.exit(0)));
