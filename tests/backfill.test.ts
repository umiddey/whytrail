import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempRepo, removeRepo, type TempRepo } from "./helpers/repo";
import { repoContext } from "../src/git";
import { planFromFile } from "../src/plans";
import { backfill, links } from "../src/write-side";
let repos:TempRepo[]=[];
function makeRepo():TempRepo{const repo=makeTempRepo();repos[repos.length]=repo;return repo;}
afterEach(()=>{for(const repo of repos)removeRepo(repo);repos=[];});
describe("backfill",()=>{
 test("records trailer and co-commit evidence idempotently; dry run does not write",()=>{const repo=makeRepo(),planPath="docs/plans/20260101_0900_alpha.md",text="# Alpha\n\n## Goal\nBuild thing\n";repo.write(planPath,text);repo.write("src/a.ts","one\n");repo.commit(["docs","src"],"plan and code");const ctx=repoContext(repo.root),plans=[planFromFile(repo.root,planPath,text)];const preview=backfill(ctx,plans,{dryRun:true});expect(preview).toContain("co-commit high: 1");expect(links(ctx)).toHaveLength(0);backfill(ctx,plans,{dryRun:false});expect(links(ctx)).toHaveLength(1);expect(backfill(ctx,plans,{dryRun:false})).toContain("new links: 0");expect(links(ctx)[0].source).toBe("co-commit");});
});
