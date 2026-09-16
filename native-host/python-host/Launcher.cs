// stdio proxy launcher: lets Chrome Native Messaging run the Python host
// without requiring a .NET SDK. Compiles with the .NET Framework
// csc.exe that ships with Windows:
//
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:winexe \
//     /out:YouTubeYtDlpHost.exe Launcher.cs
//
// Why a proxy instead of plain forwarding: with UseShellExecute=false and
// no redirections, .NET does not inherit the stdio pipes into the child,
// so the Python host would get broken stdin. Here we redirect explicitly
// and pump bytes between Chrome and the child on background threads.
//
// Compile as winexe so no console window appears.
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

sealed class Launcher
{
    static string FindOnPath(string name)
    {
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in path.Split(';'))
        {
            try
            {
                string candidate = Path.Combine(dir.Trim(), name);
                if (candidate.Length > 0 && File.Exists(candidate))
                {
                    return candidate;
                }
            }
            catch
            {
            }
        }
        return null;
    }

    static void Pump(Stream src, Stream dst)
    {
        try
        {
            byte[] buf = new byte[8192];
            int n;
            while ((n = src.Read(buf, 0, buf.Length)) > 0)
            {
                dst.Write(buf, 0, n);
                dst.Flush();
            }
        }
        catch
        {
        }
        try
        {
            dst.Close();
        }
        catch
        {
        }
    }

    static int Main()
    {
        try
        {
            string dir = Path.GetDirectoryName(
                System.Reflection.Assembly.GetExecutingAssembly().Location);
            string script = Path.Combine(dir, "host.py");

            string custom = Environment.GetEnvironmentVariable("YTDLP_HOST_PYTHON");
            string python = (custom != null && custom.Length > 0 && File.Exists(custom))
                ? custom
                : FindOnPath("pythonw.exe") ?? FindOnPath("python.exe");
            if (python == null || !File.Exists(script))
            {
                return 1;
            }

            ProcessStartInfo psi = new ProcessStartInfo(python, "\"" + script + "\"");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardInput = true;
            psi.RedirectStandardOutput = true;
            psi.WorkingDirectory = dir;
            using (Process p = Process.Start(psi))
            {
                Stream chromeIn = Console.OpenStandardInput();
                Stream chromeOut = Console.OpenStandardOutput();

                Thread up = new Thread(delegate()
                {
                    Pump(chromeIn, p.StandardInput.BaseStream);
                });
                up.IsBackground = true;

                Thread down = new Thread(delegate()
                {
                    Pump(p.StandardOutput.BaseStream, chromeOut);
                });
                down.IsBackground = true;

                up.Start();
                down.Start();
                p.WaitForExit();
                down.Join(2000);
                try
                {
                    chromeOut.Flush();
                }
                catch
                {
                }
                return p.ExitCode;
            }
        }
        catch
        {
            return 1;
        }
    }
}
