"""Deliver one scheduled check to the existing Codex conversation."""
import sqlite3
import subprocess
from contextlib import closing
from pathlib import Path

HERE = Path(__file__).resolve().parent
THREAD = '01a19ad4-9741-75e0-8ed3-fa436e17d5c8'
QUEUE_DB = Path.home() / '.codex' / 'queue_1.sqlite'


def pending_messages():
    """Messages already queued for THREAD that the conversation has not picked up yet."""
    if not QUEUE_DB.exists():
        return 0
    with closing(sqlite3.connect(f'file:{QUEUE_DB}?mode=ro', uri=True, timeout=10)) as db:
        return db.execute('SELECT count(*) FROM queued_items WHERE thread_id = ?', (THREAD,)).fetchone()[0]


if __name__ == '__main__':
    # Never stack checks: if the previous one is still undelivered, the conversation is not
    # consuming them, and a later resume would replay every stale prompt in a row
    # (07–11.11.2026 collected 100 of them). Fail loudly instead of adding another.
    pending = pending_messages()
    if pending:
        print(f'skip: {pending} earlier check(s) still undelivered for thread {THREAD}', flush=True)
        raise SystemExit(1)
    result = subprocess.run(
        ['/home/user/.local/bin/codex', 'queue', '--thread', THREAD,
         '--message', (HERE / 'prompt.txt').read_text(), '--resume'],
        cwd='/home/user/Qwen2API', text=True, capture_output=True, timeout=90,
    )
    print(result.stdout, end='', flush=True)
    print(result.stderr, end='', flush=True)
    # A failed resume may return zero: surface it in systemd rather than retrying
    # blindly and enqueueing duplicate messages.
    warning = 'warn' in result.stderr.lower() or 'failed' in result.stderr.lower()
    raise SystemExit(result.returncode or (1 if warning else 0))
