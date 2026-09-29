import fs from 'node:fs/promises';
export const generatedSkillCatalog=new URL('./.local/skill-catalog.json',import.meta.url);
export const templateSkillCatalog=new URL('./skill-catalog.json',import.meta.url);
export async function resolveSkillCatalog(){
 try{await fs.access(generatedSkillCatalog);return generatedSkillCatalog;}catch(error){if(error.code!=='ENOENT')throw error;return templateSkillCatalog;}
}
