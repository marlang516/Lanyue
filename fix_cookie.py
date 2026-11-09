import re

with open('src/main/ipc/playlist/infra/index.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Extract variable name from destructure line
var_name = None
for line in lines:
    if 'defaultCookie' in line:
        m = re.search(r'cookie:\s*(\S+)\s*=', line)
        if m:
            var_name = m.group(1)
            break

print(f"Extracted var name: {var_name}")

# Replace the broken cookie line in return statement
new_lines = []
for line in lines:
    stripped = line.strip()
    # Match the return-statement cookie line (not destructure, not comment)
    if stripped.startswith('cookie:') and 'defaultCookie' not in line and '=' not in stripped.split('cookie:')[1] if 'cookie:' in stripped else False:
        new_lines.append('    cookie: ' + var_name + ',\n')
    else:
        new_lines.append(line)

with open('src/main/ipc/playlist/infra/index.js', 'w', encoding='utf-8') as f:
    f.writelines(new_lines)

# Verify
with open('src/main/ipc/playlist/infra/index.js', 'r', encoding='utf-8') as f:
    content = f.read()
for i, line in enumerate(content.split('\n'), 1):
    if 'cookie' in line.lower() and 'defaultCookie' not in line and '@param' not in line and 'Cookie' not in line:
        print(f"Line {i}: {line}")
PYEOF