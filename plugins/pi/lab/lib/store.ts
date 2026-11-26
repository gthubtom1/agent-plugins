import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Phrase {
  id: string;
  text: string;
}
export interface LabData {
  version: 1;
  phrases: Phrase[];
}

export function readPhrases(file: string): LabData {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, phrases: [] };
    throw error;
  }
  const data = JSON.parse(raw.replace(/^\uFEFF/, ""));
  const ids = new Set<string>();
  if (data?.version !== 1 || !Array.isArray(data.phrases) || !data.phrases.every((p: Phrase) => {
    if (!p || typeof p.id !== "string" || !p.id || typeof p.text !== "string" || !p.text.trim() || ids.has(p.id)) return false;
    ids.add(p.id);
    return true;
  })) throw new Error(`常用语文件格式无效，请检查 ${file}；原文件未改动。`);
  return data;
}

/** Read and write synchronously so sessions in one Pi Web process cannot interleave mutations. */
export function changePhrases(file: string, change: (data: LabData) => void): LabData {
  const data = readPhrases(file);
  change(data);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
  return data;
}

export function addPhrase(file: string, text: string): LabData {
  if (!text.trim()) throw new Error("常用语不能为空。");
  return changePhrases(file, (data) => { data.phrases.push({ id: randomUUID(), text }); });
}

export function replacePhrase(file: string, original: Phrase, text?: string): LabData {
  if (text !== undefined && !text.trim()) throw new Error("常用语不能为空；移除请使用删除菜单。");
  return changePhrases(file, (data) => {
    const index = data.phrases.findIndex((p) => p.id === original.id);
    if (index < 0 || data.phrases[index].text !== original.text) {
      throw new Error("这条常用语已在其他窗口修改或删除，请重新打开菜单。");
    }
    if (text === undefined) data.phrases.splice(index, 1);
    else data.phrases[index] = { ...original, text };
  });
}

export function phraseLabel(phrase: Phrase, index: number): string {
  const preview = phrase.text.replace(/[\s\x00-\x1f\x7f-\x9f]+/g, " ").trim();
  const chars = Array.from(preview);
  return `${index + 1}. ${chars.slice(0, 90).join("")}${chars.length > 90 ? "…" : ""}`;
}
