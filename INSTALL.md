# 安装到 Cursor

本目录是 **主副本**：在仓库根目录 `follow-competitor/` 下编辑；装到 Cursor 时把内容同步到技能目录即可。

安装后的**初始化清单**与**对话唤醒词**见同目录 [`README.md`](README.md)。

## 1. 项目内技能（推荐，与当前仓库绑定）

在仓库根目录执行：

```bash
rsync -a --delete --exclude=node_modules \
  ./follow-competitor/ ./.cursor/skills/follow-competitor/
```

然后在 `follow-competitor/scripts/` 下安装依赖（若尚未安装）：

```bash
cd ./follow-competitor/scripts && npm install
cd ../../.cursor/skills/follow-competitor/scripts && npm install
```

## 2. 个人全局技能（所有项目可用）

```bash
mkdir -p ~/.cursor/skills
rsync -a --delete --exclude=node_modules \
  ./follow-competitor/ ~/.cursor/skills/follow-competitor/
cd ~/.cursor/skills/follow-competitor/scripts && npm install
```

## 说明

- `--delete` 会删除目标侧多出来的文件，保证与主副本一致；若不想删目标独有文件，去掉 `--delete`。
- `node_modules` 不同步，两边各自 `npm install` 即可。

## 用户配置模板

首次可把 `config/config.example.json` 或 `config/config.example.feishu-app.json` 复制到 `~/.follow-competitor/config.json` 后按需修改；飞书两种投递方式与字段说明见 `SKILL.md` 的 **First run — onboarding**。
