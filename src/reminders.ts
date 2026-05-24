import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface Reminder {
  title: string;
  listName: string;
  dueDate: string | null;
  notes: string;
}

async function runJxa(script: string): Promise<string> {
  const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script]);
  return stdout.trim();
}

export async function getReminders(listName?: string): Promise<Reminder[]> {
  const script = `
    const app = Application('Reminders');
    const listNameFilter = ${JSON.stringify(listName ?? null)};

    const allLists = app.lists();
    const targetLists = listNameFilter
      ? allLists.filter(l => l.name() === listNameFilter)
      : allLists;

    if (listNameFilter && targetLists.length === 0) {
      throw new Error('List not found: ' + listNameFilter);
    }

    const results = [];
    for (const list of targetLists) {
      for (const r of list.reminders()) {
        if (!r.completed()) {
          let dueDate = null;
          try { const d = r.dueDate(); if (d) dueDate = d.toISOString(); } catch (e) {}
          let notes = '';
          try { notes = r.body() || ''; } catch (e) {}
          results.push({ title: r.name(), listName: list.name(), dueDate, notes });
        }
      }
    }

    JSON.stringify(results);
  `;

  const raw = await runJxa(script);
  return JSON.parse(raw) as Reminder[];
}

export async function addReminder(
  title: string,
  listName?: string,
  dueDate?: string,
  notes?: string
): Promise<{ title: string; listName: string }> {
  const script = `
    const app = Application('Reminders');
    const titleParam    = ${JSON.stringify(title)};
    const listNameParam = ${JSON.stringify(listName ?? null)};
    const dueDateParam  = ${JSON.stringify(dueDate ?? null)};
    const notesParam    = ${JSON.stringify(notes ?? '')};

    const allLists = app.lists();
    let targetList;
    if (listNameParam) {
      const found = allLists.filter(l => l.name() === listNameParam);
      if (found.length === 0) throw new Error('List not found: ' + listNameParam);
      targetList = found[0];
    } else {
      targetList = allLists[0];
    }

    const props = { name: titleParam, body: notesParam };
    if (dueDateParam) props.dueDate = new Date(dueDateParam);

    app.make({ new: 'reminder', at: targetList, withProperties: props });
    JSON.stringify({ title: titleParam, listName: targetList.name() });
  `;

  const raw = await runJxa(script);
  return JSON.parse(raw) as { title: string; listName: string };
}
