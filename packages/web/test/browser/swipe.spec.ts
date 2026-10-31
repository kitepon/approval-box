import { test, expect, type Page } from "@playwright/test";
const decision = {id:"K-SWIPE",title:"Decision",context:"Background",status:"answered",version:2,urgency:"normal",created_at:new Date().toISOString(),updated_at:new Date().toISOString(),source:{via:"remote",client:"codex",session_label:"test"},options:[{id:"yes",label:"Yes"},{id:"no",label:"No"}],answer:{text:"Done"},history:[],resume_phrase:"resume"};
async function fixture(page:Page,status="answered") {
  await page.addInitScript(()=>localStorage.setItem("approval-box.session","synthetic"));
  await page.route("**/v1/**",route=>{
    const path=new URL(route.request().url()).pathname;
    const body=path==="/v1/me"?{plan:"trial",setup:{verified:true}}:path==="/v1/decisions/K-SWIPE"?{...decision,status}:path==="/v1/decisions"?{items:[]}:{};
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(body)});
  });
  await page.goto("/d/K-SWIPE");await expect(page.getByRole("heading",{name:"Decision"})).toBeVisible();
}
async function swipe(page:Page,dx:number,dy=0,target="h1") {
  const el=page.locator(target);
  await el.dispatchEvent("touchstart",{touches:[{identifier:1,clientX:150,clientY:200}]});
  await el.dispatchEvent("touchmove",{touches:[{identifier:1,clientX:150+dx,clientY:200+dy}]});
  await el.dispatchEvent("touchend",{touches:[],changedTouches:[{identifier:1,clientX:150+dx,clientY:200+dy}]});
}
for(const dx of [-120,120]) test(`completed decision returns to inbox with swipe ${dx}`,async({page})=>{
  await fixture(page);await swipe(page,dx);await expect(page).toHaveURL(/\/$/);
});
test("scrolls, short drags, links and pending answers do not leave the detail",async({page})=>{
  await fixture(page);await swipe(page,120,100);await swipe(page,30);await swipe(page,120,0,"button.back");await expect(page).toHaveURL(/\/d\/K-SWIPE$/);
  await page.unrouteAll();await fixture(page,"pending");await page.getByRole("textbox").fill("Keep draft");await swipe(page,120);
  await expect(page.getByRole("textbox")).toHaveValue("Keep draft");await expect(page).toHaveURL(/\/d\/K-SWIPE$/);
});
test("held request can return, but a held reply draft is preserved",async({page})=>{
  await fixture(page,"held");await page.getByRole("textbox").fill("Keep this");await expect(page.getByRole("button",{name:"Send text",exact:true})).toBeEnabled();await swipe(page,120);await expect(page.getByRole("textbox")).toHaveValue("Keep this");
  await page.getByRole("textbox").fill("");await expect(page.getByRole("button",{name:"Send text",exact:true})).toBeDisabled();await swipe(page,-120);await expect(page).toHaveURL(/\/$/);
});
