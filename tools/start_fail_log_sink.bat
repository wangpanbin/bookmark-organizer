@echo off
chcp 65001 >nul
title 书签整理助手 · 失败日志接收器
cd /d "%~dp0"
echo 正在启动移动失败日志接收器...
echo 日志会写到 F:\logs\bookmark-organizer\，按天一个 jsonl 文件。
echo.
echo 使用前请先在扩展面板里点一次「授权本机日志接收器」。
echo 关闭本窗口即停止接收（期间失败记录会留在扩展里，不会丢）。
echo.
python fail_log_sink.py %*
if errorlevel 1 (
  echo.
  echo [启动失败] 上面是原因。按提示处理后重试。
  pause
)
