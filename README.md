# 系统脉搏（System Pulse）

一个用于实时查看当前电脑 CPU 与内存状态的可视化看板。

## 技术栈

- Python
- FastAPI + WebSocket
- psutil
- ECharts

## 已实现功能

- 每秒实时推送 CPU/内存指标
- 指标卡片支持正常/警告/危险状态展示
- 60 秒滚动趋势图（CPU 与内存）
- CPU Top5 与内存 Top5 进程面板
- 告警中心（阈值可配、声音告警、浏览器通知）
- 历史样本统计（后端聚合，按时间范围查看均值与峰值）
- 历史数据 CSV 导出（便于留档与分析）
- 告警历史列表（本地持久化）
- 告警配置本地持久化（刷新页面不丢失）
- WebSocket 自动重连
- 采样任务异常自动恢复（避免监控中断）

## 启动方式

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload
```

浏览器打开：`http://127.0.0.1:8000`

## 接口说明

- `GET /api/metrics`：获取一次快照
- `GET /api/health`：查看服务与采样任务状态
- `WS /ws/metrics`：获取实时流
- `GET /api/history`：按时间窗口获取历史数据
- `GET /api/history/stats`：按时间窗口获取历史聚合统计
- `GET /api/history/export`：导出历史 CSV

## 可调参数

- `main.py` 中 `REFRESH_INTERVAL_SECONDS`：数据推送频率
- `main.py` 中 `PROCESS_LIMIT`：Top 进程数量
- `main.py` 中 `HISTORY_RETENTION_HOURS`：历史保留时长
- `main.py` 中 `MAX_HISTORY_JSON_LIMIT`：历史查询最大返回条数
