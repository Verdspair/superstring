using System;
using Superstring.Desktop;
internal static class LeaseFixture
{
    private static int Main(string[] args)
    {
        try
        {
            using (var lease = MaintenanceLease.Acquire(args[0], args[1] == "maintenance"))
            {
                Console.WriteLine("LEASE_ACQUIRED");
                Console.Out.Flush();
                if (args.Length > 2 && args[2] == "hold") Console.ReadLine();
            }
            return 0;
        }
        catch { Console.WriteLine("LEASE_REJECTED"); return 3; }
    }
}
