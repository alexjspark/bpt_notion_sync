import{chromium}from'@playwright/test';import{closeDb}from'@trainer/db';import{prepareProfileSaveOnce,publicProfileSaveOnce}from'../packages/engine/src/oneoff-profile-save.ts';
if(process.env.COMPANY_CDP_ENDPOINT!=='http://company-browser:9222')throw Error('PROFILE_ENDPOINT_INVALID');
const browser=await chromium.connectOverCDP(process.env.COMPANY_CDP_ENDPOINT,{timeout:15000});let page;
try{page=await browser.contexts()[0]!.newPage();page.setDefaultNavigationTimeout(15000);await page.goto('https://admin.biz-pt.com/manage/members',{waitUntil:'domcontentloaded'});
const r=await prepareProfileSaveOnce({configFile:process.env.LIVE_READONLY_CONFIG_FILE!,tokenFile:process.env.NOTION_TOKEN_FILE!,hmacFile:process.env.PREVIEW_HMAC_KEY_FILE!,companyPage:page});console.log(JSON.stringify(publicProfileSaveOnce(r)));}
finally{if(page)await page.close();await browser.close();await closeDb();}
