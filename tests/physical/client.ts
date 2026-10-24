import type{LaunchOptions}from'@playwright/test';
/** Fresh synthetic-test client only; never changes Windows proxy settings or attaches a personal browser. */
export function physicalClientOptions():LaunchOptions{return{channel:'chrome',headless:true,chromiumSandbox:true,args:['--no-proxy-server','--disable-background-networking','--disable-component-update','--disable-sync']};}
