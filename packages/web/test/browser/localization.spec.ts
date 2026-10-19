import { test, expect, type Page } from "@playwright/test";
const title = "日本語の申請 $&", context = "本文は翻訳しない <tag>";
const pending = {
  id:"K-TEST01",title,context,version:1,status:"pending",urgency:"high",created_at:new Date(Date.now()-61_000).toISOString(),updated_at:new Date().toISOString(),
  source:{via:"local",client:"codex",requester:"名前",session_label:"名前 / 作業"},
  options:[{id:"yes",label:"元の選択肢"},{id:"no",label:"Other choice"}],history:[{kind:"created",by:"ai",at:new Date().toISOString()}],resume_phrase:"元の再開文",request_attachments:[],
};
async function fixture(page: Page, signedIn=true) {
  await page.addInitScript((signedIn)=>{if(signedIn)localStorage.setItem("approval-box.session","local-fixture-only");},signedIn);
  await page.route("**/v1/**",async route=>{
    const url=new URL(route.request().url());let data:unknown={};
    if(url.pathname==="/v1/me")data={login:"google",billing:"store",plan:"trial",setup:{verified:true,checks:[]}};
    else if(url.pathname==="/v1/me/settings")data={retention_days:30};
    else if(url.pathname==="/v1/decisions")data={items:url.search.includes("answered")?[{...pending,id:"K-DONE01",status:"answered",delivery:"delivered",answer:{text:"回答の原文"}}]:[pending]};
    else if(url.pathname==="/v1/decisions/K-TEST01")data=pending;
    else if(url.pathname.endsWith("/attachments"))data={items:[]};
    else if(url.pathname==="/v1/connections")data=[];
    else if(url.pathname==="/v1/events")return route.fulfill({status:200,contentType:"text/event-stream",body:""});
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(data)});
  });
}

test("login auto-detects English; selection persists, HTML lang and OS changes follow",async({page})=>{
  await fixture(page,false);await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang","en");
  await expect(page.getByText("Requests for your decision arrive here.",{exact:false})).toBeVisible();
  await page.getByRole("combobox").selectOption("ja");await expect(page.locator("html")).toHaveAttribute("lang","ja");
  await page.reload();await expect(page.getByText("AIが判断を求める時に、ここへ集まります。",{exact:false})).toBeVisible();
  await page.getByRole("combobox").selectOption("system");await expect(page.locator("html")).toHaveAttribute("lang","en");
  await page.evaluate(()=>{Object.defineProperty(navigator,"languages",{value:["ja-JP"],configurable:true});window.dispatchEvent(new Event("languagechange"));});
  await expect(page.locator("html")).toHaveAttribute("lang","ja");
});

test("all main pages use English while content and reply drafts survive language switching",async({page})=>{
  await fixture(page);await page.goto("/");
  await expect(page.getByRole("link",{name:"Inbox"})).toBeVisible();await expect(page.getByText(title,{exact:true})).toBeVisible();
  await expect(page.getByText("1 minute ago",{exact:true})).toBeVisible();
  await page.getByText(title,{exact:true}).click();
  await expect(page.getByRole("heading",{name:title})).toBeVisible();await expect(page.getByText(context,{exact:true})).toBeVisible();
  const draft="回答 draft $&";await page.getByRole("textbox").fill(draft);
  await page.getByRole("combobox").selectOption("ja");await expect(page.getByRole("button",{name:"文だけで答える",exact:true})).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveValue(draft);
  await page.getByRole("combobox").selectOption("en");await expect(page.getByRole("button",{name:"Send text",exact:true})).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveValue(draft);
  await page.getByRole("link",{name:"Completed"}).click();await expect(page.getByText("Delivered to AI",{exact:true})).toBeVisible();
  await page.getByRole("link",{name:"Connections",exact:true}).click();await expect(page.getByRole("heading",{name:"Add a device",exact:true})).toBeVisible();
  await page.getByRole("link",{name:"Settings"}).click();await expect(page.getByText("Signed in with Google.")).toBeVisible();
  await expect(page.getByRole("button",{name:"Delete account and all data"})).toBeVisible();
});

test("English destructive confirmation rejects a wrong confirmation word before any delete",async({page})=>{
  await fixture(page);let deletions=0;page.on("request",req=>{if(req.method()==="DELETE")deletions++;});await page.goto("/settings");
  const messages:string[]=[];
  page.on("dialog",async dialog=>{messages.push(dialog.message());if(dialog.type()==="confirm")await dialog.accept();else await dialog.accept("wrong");});
  await page.getByRole("button",{name:"Delete account and all data"}).click();
  await expect.poll(()=>messages.length).toBe(2);expect(messages[0]).toContain("cannot be undone");expect(messages[1]).toBe("Type DELETE to confirm");expect(deletions).toBe(0);
});

test("unsupported browser language falls back to Japanese and storage failure allows English choice",async({browser})=>{
  const ctx=await browser.newContext({locale:"fr-FR"});const page=await ctx.newPage();await fixture(page,false);
  await page.addInitScript(()=>{Storage.prototype.setItem=()=>{throw new Error("storage blocked");};});
  await page.goto("/");await expect(page.locator("html")).toHaveAttribute("lang","ja");
  await page.getByRole("combobox").selectOption("en");await expect(page.locator("html")).toHaveAttribute("lang","en");
  await expect(page.getByText("Requests for your decision arrive here.",{exact:false})).toBeVisible();await ctx.close();
});

test("English navigation and account controls fit a narrow phone screen",async({page})=>{
  await page.setViewportSize({width:320,height:740});await fixture(page);await page.goto("/settings");
  await expect(page.getByRole("heading",{name:"Settings"})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  for(const name of ["Inbox","Completed","Connections","Settings"]){
    const box=await page.getByRole("link",{name:name==='Inbox'?/Inbox/:name,exact:name!=='Inbox'}).boundingBox();
    expect(box).not.toBeNull();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(321);
  }
});

for(const language of [
  {tag:"ko-KR",code:"ko",settings:"설정",send:"글로만 답변",remove:"계정과 모든 데이터 삭제",prompt:"확인을 위해 ‘삭제’를 입력해 주세요"},
  {tag:"zh-CN",code:"zh-Hans",settings:"设置",send:"仅发送文字",remove:"删除账号及所有数据",prompt:"请输入“删除”以确认"},
  {tag:"zh-TW",code:"zh-Hant",settings:"設定",send:"僅傳送文字",remove:"刪除帳號及所有資料",prompt:"請輸入「刪除」以確認"},
]) test(`${language.code}: auto-detection, UI, literal content, drafts, persistence and confirmation`,async({browser})=>{
  const ctx=await browser.newContext({locale:language.tag,viewport:{width:320,height:740}});const page=await ctx.newPage();
  try {
    await fixture(page);const headers:string[]=[];
    page.on("request",req=>{if(new URL(req.url()).pathname==="/v1/me")headers.push(req.headers()["accept-language"]!);});
    await page.goto("/d/K-TEST01");await expect(page.locator("html")).toHaveAttribute("lang",language.code);
    await expect(page.getByRole("heading",{name:title})).toBeVisible();await expect(page.getByText(context,{exact:true})).toBeVisible();
    await expect(page.getByRole("button",{name:language.send,exact:true})).toBeVisible();await page.getByRole("textbox").fill("답변 原文 $& <tag>");
    await page.getByRole("combobox").selectOption("en");await expect(page.getByRole("button",{name:"Send text",exact:true})).toBeVisible();
    await page.getByRole("combobox").selectOption(language.code);await expect(page.getByRole("textbox")).toHaveValue("답변 原文 $& <tag>");
    await page.reload();await expect(page.getByRole("combobox")).toHaveValue(language.code);
    await page.getByRole("link",{name:language.settings}).click();await expect(page.getByRole("heading",{name:language.settings,exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect.poll(()=>headers).toContain(language.code);
    const prompts:string[]=[];let writes=0;
    page.on("request",req=>{if(req.method()==="DELETE")writes++;});
    page.on("dialog",async dialog=>{if(dialog.type()==="confirm")await dialog.accept();else{prompts.push(dialog.message());await dialog.accept("wrong");}});
    await page.getByRole("button",{name:language.remove,exact:true}).click();await expect.poll(()=>prompts.length).toBe(1);expect(prompts[0]).toBe(language.prompt);expect(writes).toBe(0);
  } finally {await ctx.close();}
});
