// 给测试脚本用的鼠标 / 窗口小工具
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct WinRect {
  public int Left;
  public int Top;
  public int Right;
  public int Bottom;
}

public class Mouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  // PowerShell 宿主不是 DPI 感知的，GetWindowRect 拿到的是缩放后的虚拟坐标，
  // 而 SetCursorPos 要物理坐标，缩放不是 100% 的机器上点不准
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out WinRect rect);
  // 摆件和设置面板是同一个进程的两个窗口，只能按标题找
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);

  public static void Click(uint down, uint up) {
    mouse_event(down, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(40);
    mouse_event(up, 0, 0, 0, IntPtr.Zero);
  }
}
