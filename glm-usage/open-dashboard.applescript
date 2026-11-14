on run
	-- 服务由 LaunchAgent（com.liangfeng.glm-usage-dashboard）常驻保障；这里只负责弹独立窗口
	do shell script "open -na \"Google Chrome\" --args --app=http://127.0.0.1:8791 --window-size=1000,1080"
end run
