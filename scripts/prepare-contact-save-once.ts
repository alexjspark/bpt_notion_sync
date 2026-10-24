import{chromium}from'@playwright/test';import{closeDb}from'@trainer/db';
import{prepareContactSaveOnce,publicContactSaveOnce}from'../packages/engine/src/oneoff-contact-save.ts';
if(process.env.COMPANY_CDP_ENDPOINT!=='http://company-browser:9222')throw Error('CONTACT_SAVE_ENDPOINT_INVALID');
const browser=await chromium.connectOverCDP(process.env.COMPANY_CDP_ENDPOINT,{timeout:15000});
try{const page=browser.contexts()[0]?.pages().find(p=>p.url().startsWith('https://admin.biz-pt.com/'));if(!page)throw Error('COMPANY_PAGE_REQUIRED');
const r=await prepareContactSaveOnce({configFile:process.env.LIVE_READONLY_CONFIG_FILE!,tokenFile:process.env.NOTION_TOKEN_FILE!,hmacFile:process.env.PREVIEW_HMAC_KEY_FILE!,companyPage:page});console.log(JSON.stringify(publicContactSaveOnce(r)));}
finally{await browser.close();await closeDb();}
