import :contentReference[oaicite:2]{index=2}son
import subprocess
from pathlib import Path

def title_from_path(p: str) -> str:
    base = Path(p).stem.replace("_", " ").replace("-", " ").strip()
    return (base[:1].upper() + base[1:]) if base else Path(p).name

ISC_LICENSE = """ISC License

Copyright (c) 2026

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
"""

def md_skeleton(path: str) -> str:
    t = title_from_path(path)
    return f"""# {t}

## Purpose
## Scope
## Roles & Ownership
## Procedure
## Controls & Evidence
## Metrics
## Risks
## TODO
"""

def openapi_skeleton(title: str) -> str:
    return f"""openapi: 3.0.3
info:
  title: {title}
  version: 0.1.0
servers:
  - url: http://localhost:3000
paths:
  /health:
    get:
      summary: Health check
      responses:
        "200":
          description: OK
"""

def k8s_yaml_skeleton(name: str) -> str:
    return f"""apiVersion: apps/v1
kind: Deployment
metadata:
  name: {name}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: {name}
  template:
    metadata:
      labels:
        app: {name}
    spec:
      containers:
        - name: {name}
          image: REPLACE_ME
          ports:
            - containerPort: 3000
"""

def pkg_json_skeleton(name: str) -> str:
    return json.dumps({
        "name": name,
        "private": True,
        "version": "0.1.0",
        "scripts": {
            "dev": "next dev",
            "build": "next build",
            "start": "next start",
            "lint": "next lint"
        }
    }, indent=2) + "\n"

def tsconfig_skeleton() -> str:
    return json.dumps({
        "compilerOptions": {
            "target": "ES2022",
            "lib": ["dom", "dom.iterable", "es2022"],
            "allowJs": True,
            "skipLibCheck": True,
            "strict": True,
            "noEmit": True,
            "esModuleInterop": True,
            "module": "esnext",
            "moduleResolution": "bundler",
            "resolveJsonModule": True,
            "isolatedModules": True,
            "jsx": "preserve"
        },
        "include": ["**/*.ts", "**/*.tsx"],
        "exclude": ["node_modules"]
    }, indent=2) + "\n"

def next_config_skeleton() -> str:
    return """/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
};
module.exports = nextConfig;
"""

def dts_skeleton() -> str:
    return """declare module "*.json" { const value: any; export default value; }
declare module "*.yaml" { const value: any; export default value; }
declare module "*.yml" { const value: any; export default value; }
export {};
"""

def dockerfile_skeleton(service: str) -> str:
    return f"""FROM node:22.10.0-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm i
COPY . .
ENV NODE_ENV=production
CMD ["npm","run","start"]
# {service}
"""

def tf_skeleton() -> str:
    return """terraform {
  required_version = ">= 1.6.0"
}
# TODO: providers/modules/remote state.
"""

def sql_skeleton(path: str) -> str:
    name = title_from_path(path)
    return f"""-- {name}
-- TODO: add schema/migrations

BEGIN;

-- example:
-- CREATE TABLE IF NOT EXISTS example (
--   id BIGSERIAL PRIMARY KEY,
--   created_at TIMESTAMPTZ NOT NULL DEFAULT now()
-- );

COMMIT;
"""

def npmrc_skeleton() -> str:
    # yorum satırı # ile güvenli
    return """# Repo defaults
fund=false
audit=false
save-exact=true
"""

def yaml_generic(path: str) -> str:
    low = path.lower()
    if "openapi" in low:
        return openapi_skeleton(title_from_path(path))
    if "/k8s/" in path.replace("\\", "/"):
        return k8s_yaml_skeleton(Path(path).stem)
    return "# TODO: fill config\n"

def make_xlsx(path: str) -> None:
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "Controls"
    ws.append(["Control ID", "Control Name", "Owner", "Frequency", "Evidence", "Status", "Notes"])
    ws.append(["CTRL-001", "Example control", "TBD", "Monthly", "TBD", "Draft", "Replace with real controls"])
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)

def write_text(path: str, content: str) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(content, encoding="utf-8", newline="\n")

def main() -> int:
    tracked = subprocess.check_output(["git", "ls-files", "-z"]).decode("utf-8", "ignore").split("\x00")
    tracked = [p for p in tracked if p]
    zero = [p for p in tracked if os.path.isfile(p) and os.path.getsize(p) == 0]

    if not zero:
        print("No 0-byte tracked files.")
        return 0

    print(f"Found {len(zero)} 0-byte tracked files. Filling...")

    for p in zero:
        ext = Path(p).suffix.lower()
        norm = p.replace("\\", "/")

        if norm == "LICENSE":
            write_text(p, ISC_LICENSE); continue
        if norm == ".npmrc":
            write_text(p, npmrc_skeleton()); continue
        if norm == "README.md":
            write_text(p, "# GOLDENRUSH-GRUSH\n\n## Quickstart\n\n## TODO\n"); continue
        if norm == "CHANGELOG.md":
            write_text(p, "# Changelog\n\n## Unreleased\n- Initial scaffold.\n"); continue
        if norm.endswith("controls_matrix.xlsx"):
            make_xlsx(p); continue

        if ext == ".md":
            write_text(p, md_skeleton(p))
        elif ext == ".sql":
            write_text(p, sql_skeleton(p))
        elif ext == ".json":
            if Path(p).name == "package.json":
                name = "grush-" + re.sub(r"[^a-z0-9-]+", "-", Path(p).parent.name.lower())
                write_text(p, pkg_json_skeleton(name))
            elif Path(p).name == "tsconfig.json":
                write_text(p, tsconfig_skeleton())
            else:
                write_text(p, "{}\n")
        elif ext in [".yaml", ".yml"]:
            write_text(p, yaml_generic(p))
        elif ext == ".ts":
            write_text(p, f"// {p}\n// TODO: implement\nexport {{}};\n")
        elif ext == ".js":
            if Path(p).name == "next.config.js":
                write_text(p, next_config_skeleton())
            else:
                write_text(p, f"// {p}\nmodule.exports = {{}};\n")
        elif ext == ".d.ts":
            write_text(p, dts_skeleton())
        elif Path(p).name.lower().startswith("dockerfile"):
            write_text(p, dockerfile_skeleton(Path(p).name))
        elif ext == ".tf":
            write_text(p, tf_skeleton())
        else:
            write_text(p, f"# TODO: fill {p}\n")

    print("Done.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())