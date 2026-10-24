import {defineConfig} from '@playwright/test';
const url=new URL(process.env.BASE_URL??'http://preview-test-web:3000');
if(url.protocol!=='http:'||url.hostname!=='preview-test-web'||url.port!=='3000'||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw new Error('CONNECTED_E2E_REQUIRES_ISOLATED_TEST_WEB');
export default defineConfig({testDir:'./tests/e2e-connected',testMatch:'**/*.spec.ts',fullyParallel:false,workers:1,retries:0,forbidOnly:true,timeout:60000,expect:{timeout:10000},reporter:'list',outputDir:'test-results/connected-preview',
use:{baseURL:url.origin,browserName:'chromium',headless:true,viewport:{width:1440,height:1080},actionTimeout:10000,navigationTimeout:30000,serviceWorkers:'block',trace:'retain-on-failure',screenshot:'only-on-failure',video:'off'}});
