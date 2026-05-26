import { google } from "googleapis";
import { getAuthClient } from "./google-auth.js";

export interface Task {
  id: string;
  title: string;
  due: string | null;
  notes: string | null;
  status: "needsAction" | "completed";
  listId: string;
  listTitle: string;
}

export interface TaskList {
  id: string;
  title: string;
}

export async function getTaskLists(): Promise<TaskList[]> {
  const auth = await getAuthClient();
  const tasks = google.tasks({ version: "v1", auth });
  const res = await tasks.tasklists.list({ maxResults: 20 });
  return (res.data.items ?? []).map((l) => ({ id: l.id ?? "", title: l.title ?? "" }));
}

export async function getTasks(listName?: string): Promise<Task[]> {
  const auth = await getAuthClient();
  const tasks = google.tasks({ version: "v1", auth });

  const lists = await getTaskLists();
  const targetLists = listName
    ? lists.filter((l) => l.title.toLowerCase().includes(listName.toLowerCase()))
    : lists;

  const results: Task[] = [];
  await Promise.all(
    targetLists.map(async (list) => {
      const res = await tasks.tasks.list({
        tasklist: list.id,
        showCompleted: false,
        maxResults: 50,
      });
      for (const t of res.data.items ?? []) {
        results.push({
          id: t.id ?? "",
          title: t.title ?? "",
          due: t.due ?? null,
          notes: t.notes ?? null,
          status: (t.status as "needsAction" | "completed") ?? "needsAction",
          listId: list.id,
          listTitle: list.title,
        });
      }
    })
  );
  return results;
}

export async function addTask(
  title: string,
  listName?: string,
  due?: string,
  notes?: string
): Promise<Task> {
  const auth = await getAuthClient();
  const tasks = google.tasks({ version: "v1", auth });

  const lists = await getTaskLists();
  let list = lists[0];
  if (listName) {
    const found = lists.find((l) => l.title.toLowerCase().includes(listName.toLowerCase()));
    if (found) {
      list = found;
    } else {
      // Create the list if it doesn't exist
      const created = await tasks.tasklists.insert({ requestBody: { title: listName } });
      list = { id: created.data.id ?? "", title: created.data.title ?? listName };
    }
  }

  const body: { title: string; notes?: string; due?: string } = { title };
  if (notes) body.notes = notes;
  if (due) {
    // Google Tasks due must be RFC3339 with time zeroed: 2026-05-25T00:00:00.000Z
    const d = new Date(due);
    if (!isNaN(d.getTime())) {
      d.setUTCHours(0, 0, 0, 0);
      body.due = d.toISOString();
    }
  }

  const res = await tasks.tasks.insert({ tasklist: list.id, requestBody: body });
  const t = res.data;
  return {
    id: t.id ?? "",
    title: t.title ?? "",
    due: t.due ?? null,
    notes: t.notes ?? null,
    status: "needsAction",
    listId: list.id,
    listTitle: list.title,
  };
}

export async function completeTask(taskId: string, listId: string): Promise<void> {
  const auth = await getAuthClient();
  const tasks = google.tasks({ version: "v1", auth });
  await tasks.tasks.patch({
    tasklist: listId,
    task: taskId,
    requestBody: { status: "completed" },
  });
}
