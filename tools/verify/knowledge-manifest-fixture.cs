using System;
using System.IO;
using Superstring.Setup;

internal static class KnowledgeManifestFixture
{
    private static int passed;
    private static string Json(int version, bool knowledge, bool reading = false, bool organization = false)
    {
        string hash = new string('0', 64);
        string files = "";
        foreach (string file in Manifest.RequiredFiles)
        {
            if (files.Length > 0) files += ",";
            files += "{\"path\":\"" + file + "\",\"sha256\":\"" + hash + "\"}";
        }
        if (knowledge) files += ",{\"path\":\"app/resources/migrations/versions/0002_knowledge.sql\",\"sha256\":\"" + hash + "\"}";
        if (reading) files += ",{\"path\":\"app/resources/migrations/versions/0003_knowledge_read.sql\",\"sha256\":\"" + hash + "\"}";
        if (organization) files += ",{\"path\":\"app/resources/migrations/versions/0004_organization.sql\",\"sha256\":\"" + hash + "\"}";
        return "{\"manifestVersion\":1,\"layoutVersion\":1,\"businessSchemaVersion\":" + version
            + ",\"product\":\"superstring\",\"platform\":\"win32-x64\",\"version\":\"0.2.1\",\"files\":["
            + files + "],\"launcher\":{\"path\":\"superstring.exe\",\"sha256\":\"" + hash + "\"}}";
    }
    private static void Check(bool condition)
    {
        if (!condition) throw new Exception("Manifest assertion failed");
        passed++;
    }
    private static void Reject(Action action)
    {
        try { action(); }
        catch (InvalidDataException) { passed++; return; }
        throw new Exception("Expected manifest rejection");
    }
    public static int Main()
    {
        Check(Manifest.Parse(Json(4, true, true, true)).SchemaVersion == 4);
        Check(Manifest.Parse(Json(4, true, true, true), true).SchemaVersion == 4);
        Reject(delegate { Manifest.Parse(Json(3, true, true)); });
        Reject(delegate { Manifest.Parse(Json(4, true, false, true)); });
        Reject(delegate { Manifest.Parse(Json(4, false, true, true)); });
        Reject(delegate { Manifest.Parse(Json(5, true, true, true), true); });
        Check(Manifest.Parse(Json(3, true, true), true).SchemaVersion == 3);
        Reject(delegate { Manifest.Parse(Json(2, true)); });
        Reject(delegate { Manifest.Parse(Json(3, true)); });
        Reject(delegate { Manifest.Parse(Json(3, false, true)); });
        Reject(delegate { Manifest.Parse(Json(3, true), true); });
        Check(Manifest.Parse(Json(2, true), true).SchemaVersion == 2);
        Check(Manifest.Parse(Json(1, false), true).SchemaVersion == 1);
        Reject(delegate { Manifest.Parse(Json(1, false)); });
        Reject(delegate { Manifest.Parse(Json(2, false)); });
        Reject(delegate { Manifest.Parse(Json(2, false), true); });
        Reject(delegate { Manifest.Parse(Json(4, true, true)); });
        Reject(delegate { Manifest.Parse(Json(4, true, true), true); });
        Reject(delegate { Manifest.Parse(Json(0, true), true); });
        Reject(delegate { Manifest.Parse(Json(2, true).Replace("\"businessSchemaVersion\":2", "\"businessSchemaVersion\":\"2\"")); });
        Reject(delegate { Manifest.Parse(Json(2, true).Replace("\"product\":\"superstring\"", "\"product\":\"other\"")); });
        Console.WriteLine("{\"passed\":" + passed + ",\"failed\":0}");
        return 0;
    }
}
