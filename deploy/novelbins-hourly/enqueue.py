"""Deliver one scheduled check to the existing Codex conversation."""
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
THREAD = '01a19ad4-9741-75e0-8ed3-fa436e17d5c8'

if __name__ == '__main__':
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
