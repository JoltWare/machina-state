// Tutorial 3: thread-safe DoorLock (table-based C# with tracing and event parameters).
using System;
using System.Threading;
using System.Threading.Tasks;
using Security;

sealed class Door : DoorLock
{
    private const int Secret = 4711;
    private const int Admin = 9999;
    private readonly object gate = new();
    private int failures;

    protected override void Lock() => Monitor.Enter(gate);
    protected override void Unlock() => Monitor.Exit(gate);

    protected override bool isValidCode(int code) => code == Secret;
    protected override bool tooManyAttempts(int code) => failures >= 2 && code != Secret;
    protected override bool isAdminCode(int code) => code == Admin;
    protected override void countFailure(int code) => Console.WriteLine($"    countFailure({code}) -> {++failures} failure(s)");
    protected override void resetAttempts(int code) => failures = 0;

    protected override void engageBolt() => Console.WriteLine("    engageBolt()");
    protected override void releaseBolt() => Console.WriteLine("    releaseBolt()");
    protected override void sirenOn() => Console.WriteLine("    sirenOn()");
    protected override void sirenOff() => Console.WriteLine("    sirenOff()");

    protected override void Trace(TraceKind kind, string name) => Console.WriteLine($"  {kind,-10} {name}");
}

static class Program
{
    static void Main()
    {
        var door = new Door();
        door.Start();

        foreach (var code in new[] { 1234, 1111, 2222 })
        {
            Console.WriteLine($"DispatchEnterCode({code})");
            door.DispatchEnterCode(code);
        }
        Console.WriteLine($"Dispatch(Lock) handled: {door.Dispatch(DoorLock.Event.Lock)}");
        Console.WriteLine($"Dispatch(EnterCode) handled: {door.Dispatch(DoorLock.Event.EnterCode)}   // needs its typed method");
        Console.WriteLine("DispatchReset(9999)");
        door.DispatchReset(9999);
        Console.WriteLine("DispatchEnterCode(4711)");
        door.DispatchEnterCode(4711);
        Console.WriteLine($"state: {door.Current}");

        // Many threads may use the machine at once; Lock()/Unlock() serialise them.
        Parallel.For(0, 4, i => door.Dispatch(i % 2 == 0 ? DoorLock.Event.Lock : DoorLock.Event.Timeout));
        Console.WriteLine($"after concurrent calls: {door.Current}");
    }
}
