import {build} from 'tsup';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {chmod} from 'node:fs/promises';

const root=fileURLToPath(new URL('../',import.meta.url));
// Core first so external declarations also resolve without a previously built workspace.
for(const name of ['core','dom','react','vue','element-plus','observer']){
 await build({
  entry:{index:resolve(root,`packages/${name}/src/index.ts`)},
  outDir:resolve(root,`packages/${name}/dist`),
  tsconfig:resolve(root,'tsconfig.json'),
  format:['esm'],target:'es2022',platform:'browser',
  external:['ajv','react','vue','@clearact/core','@clearact/dom','@clearact/vue','element-plus'],
  dts:true,clean:true,splitting:false,sourcemap:false,
 });
}
for(const name of ['server','mcp']){
 await build({
  entry:{index:resolve(root,`packages/${name}/src/index.ts`),cli:resolve(root,`packages/${name}/src/cli.ts`)},
  outDir:resolve(root,`packages/${name}/dist`),
  tsconfig:resolve(root,'tsconfig.json'),
  format:['esm'],target:'es2022',platform:'node',
  external:['@clearact/core','ajv','ws','zod','@modelcontextprotocol/sdk'],
  dts:true,clean:true,splitting:false,sourcemap:false,
 });
 await chmod(resolve(root,`packages/${name}/dist/cli.js`),0o755);
}
