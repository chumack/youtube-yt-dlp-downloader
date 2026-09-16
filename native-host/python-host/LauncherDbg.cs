// Debug console build of the launcher: prints diagnostics to stderr.
using System;
using System.Diagnostics;
using System.IO;

sealed class LauncherDbg
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

    static int Main()
    {
        try
        {
            string dir = Path.GetDirectoryName(
                System.Reflection.Assembly.GetExecutingAssembly().Location);
            Console.Error.WriteLine("DBG dir=" + dir);
            string script = Path.Combine(dir, "host.py");
            Console.Error.WriteLine("DBG script=" + script + " exists=" + File.Exists(script));
            string custom = Environment.GetEnvironmentVariable("YTDLP_HOST_PYTHON");
            Console.Error.WriteLine("DBG YTDLP_HOST_PYTHON=" + (custom ?? "<null>"));
            string python = (custom != null && custom.Length > 0 && File.Exists(custom))
                ? custom
                : FindOnPath("pythonw.exe") ?? FindOnPath("python.exe");
            Console.Error.WriteLine("DBG python=" + (python ?? "<null>"));
            if (python == null)
            {
                return 11;
            }
            ProcessStartInfo psi = new ProcessStartInfo(python, "\"" + script + "\"");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WorkingDirectory = dir;
            using (Process p = Process.Start(psi))
            {
                Console.Error.WriteLine("DBG child pid=" + p.Id);
                p.WaitForExit();
                Console.Error.WriteLine("DBG child exit=" + p.ExitCode);
                return p.ExitCode;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("DBG EX: " + ex);
            return 12;
        }
    }
}
