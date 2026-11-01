"""Regenerate the complete pixel hierarchy using checked-in sources and stdlib."""
from pathlib import Path
import runpy
if __name__ == '__main__':
    runpy.run_path(str(Path(__file__).with_name('generate-hierarchy-font.py')), run_name='__main__')
