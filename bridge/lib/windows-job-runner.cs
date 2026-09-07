// Windows PowerShell 5.1 loads this small supervisor in memory. No binary install/cache.
// Job membership is assigned BEFORE launching Codex; detached descendants inherit it too.
// The sole non-inheritable job handle is held by this process, so its death kills the job.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

public static class CodexBridgeJobRunner {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    // Standard Windows argv quoting, not shell quoting. Every argument is passed as data.
    static string Quote(string value) {
        var output = new StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') { output.Append('\\', slashes * 2 + 1); output.Append(ch); }
            else { output.Append('\\', slashes); output.Append(ch); }
            slashes = 0;
        }
        output.Append('\\', slashes * 2); output.Append('"');
        return output.ToString();
    }

    static void Pump(System.IO.Stream source, System.IO.Stream destination) {
        var buffer = new byte[16384];
        int count;
        while ((count = source.Read(buffer, 0, buffer.Length)) != 0) {
            destination.Write(buffer, 0, count);
            destination.Flush(); // JSONL requests must not wait for a full stream buffer or EOF.
        }
    }

    public static void Run(string command, string[] args, string cwd) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        bool assigned = false;
        try {
            var limits = new ExtendedLimits();
            limits.BasicLimitInformation.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE; no breakaway
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new Win32Exception();
            // Assign the supervisor itself, avoiding a suspended-child assignment race.
            // Existing parent jobs nest on supported Windows versions (Windows 8+).
            if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new Win32Exception();
            assigned = true;
            var quoted = new string[args.Length];
            for (int i = 0; i < args.Length; i++) quoted[i] = Quote(args[i]);
            var start = new ProcessStartInfo(command, String.Join(" ", quoted));
            start.WorkingDirectory = cwd;
            start.UseShellExecute = false; start.CreateNoWindow = true;
            start.RedirectStandardInput = true; start.RedirectStandardOutput = true; start.RedirectStandardError = true;
            using (var child = Process.Start(start)) {
                Console.Error.WriteLine("codex-bridge-child-pid:" + child.Id);
                var input = Task.Factory.StartNew(() => {
                    try { Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream); child.StandardInput.Close(); }
                    catch (System.IO.IOException) { }
                    catch (ObjectDisposedException) { }
                }, TaskCreationOptions.LongRunning);
                var output = Task.Factory.StartNew(() => Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput()), TaskCreationOptions.LongRunning);
                var errors = Task.Factory.StartNew(() => Pump(child.StandardError.BaseStream, Console.OpenStandardError()), TaskCreationOptions.LongRunning);
                child.WaitForExit();
                // Drain available diagnostics before terminating surviving descendants and self.
                Task.WaitAll(new Task[] { output, errors }, 500);
                TerminateJobObject(job, (uint)child.ExitCode);
            }
        } finally {
            // Includes failure after assigning self or spawning a child. Closing this handle
            // ends every job member even if Codex has already exited or a descendant detached.
            if (assigned) TerminateJobObject(job, 1);
            CloseHandle(job);
        }
    }
}
