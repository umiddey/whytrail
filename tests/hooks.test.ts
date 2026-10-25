import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempRepo, removeRepo, type TempRepo } from "./helpers/repo";
import { repoContext } from "../src/git";
import { install, uninstall } from "../src/write-side";
let repos:TempRepo[]=[];
function makeRepo():TempRepo{const repo=makeTempRepo();repos[repos.length]=repo;return repo;}
afterEach(()=>{for(const repo of repos)removeRepo(repo);repos=[];});
describe("hooks",()=>{
 test("existing hooks chain, repeated install is stable, uninstall restores",()=>{const repo=makeRepo(),dir=join(repo.root,"hooks");repo.git(["config","core.hooksPath",dir]);Bun.spawnSync(["mkdir","-p",dir]);const original="#!/bin/sh\nexit 0\n";writeFileSync(join(dir,"commit-msg"),original);install(repoContext(repo.root));const installed=readFileSync(join(dir,"commit-msg"),"utf8");expect(installed).toContain("whytrail-hook-v1");expect(readFileSync(join(dir,"commit-msg.whytrail-chained"),"utf8")).toBe(original);install(repoContext(repo.root));expect(readFileSync(join(dir,"commit-msg"),"utf8")).toBe(installed);uninstall(repoContext(repo.root));expect(readFileSync(join(dir,"commit-msg"),"utf8")).toBe(original);});
 test("commit hook refuses missing trailer and accepts explicit none reason",()=>{const repo=makeRepo();install(repoContext(repo.root));repo.write("a.txt","a\n");repo.git(["add","a.txt"]);const denied=Bun.spawnSync(["git","commit","-m","missing plan"],{cwd:repo.root,stdout:"pipe",stderr:"pipe"});expect(denied.exitCode).toBe(1);expect(denied.stderr.toString()).toContain("whytrail: commit needs a Plan:");expect(repo.git(["commit","-m","init","-m","Plan: none - fixture"])).toBeTruthy();});
 test("prepare hook puts plan into existing trailer paragraph",()=>{const repo=makeRepo();install(repoContext(repo.root));repo.write("a.txt","a\n");repo.git(["add","a.txt"]);const run=Bun.spawnSync(["git","commit","-m","subject","-m","Reviewed-by: Fixture <fixture@example.com>"],{cwd:repo.root,env:{...process.env,WHYTRAIL_PLAN:"20260101_0900_alpha"},stdout:"pipe",stderr:"pipe"});expect(run.exitCode).toBe(0);expect(repo.git(["log","-1","--format=%(trailers:key=Plan,valueonly)"]).trim()).toBe("20260101_0900_alpha");});
});
