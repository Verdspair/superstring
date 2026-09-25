using System;
using System.IO;
using Superstring.Setup;

internal static class KnowledgeManifestFixture
{
    private static int passed;
    private static readonly string[] Migrations = {
        "0001_initial.sql", "0002_knowledge.sql", "0003_knowledge_read.sql", "0004_organization.sql",
        "0005_qq_transport.sql", "0006_qq_memory_sources.sql", "0007_qq_observation_text.sql",
        "0008_qq_memory_batch.sql", "0009_qq_transport_config.sql", "0010_qq_schemes.sql",
        "0011_qq_speech_log.sql", "0012_qq_media_notes.sql", "0013_qq_scheme_triggers.sql",
        "0014_qq_send_log.sql", "0015_qq_scheme_rhythm.sql", "0016_qq_context_budget.sql",
        "0017_qq_scheme_prompts.sql", "0018_qq_members.sql", "0019_qq_output_reserve.sql", "0020_qq_scheme_stickers.sql", "0021_qq_stickers.sql", "0022_qq_sticker_authorization.sql", "0023_qq_dispatch.sql", "0024_qq_media_purposes.sql", "0025_desktop_settings.sql", "0026_qq_media_supplement.sql", "0027_qq_event_addressed.sql", "0028_qq_immediate_lease.sql", "0029_qq_module_switches.sql", "0030_qq_sweep_verdicts.sql", "0031_qq_attention.sql", "0032_model_providers.sql", "0033_qq_idle_judgements.sql", "0034_qq_initiative_min_score.sql", "0035_qq_reply_split.sql", "0036_qq_judgement_reuse.sql", "0037_qq_judgement_per_speaker.sql", "0038_qq_judgement_model.sql"
    };
    private static string Json(int version, int omitMigration = 0)
    {
        string hash = new string('0', 64);
        string files = "";
        foreach (string file in Manifest.RequiredFiles)
        {
            if (omitMigration == 1 && file.EndsWith("/0001_initial.sql")) continue;
            if (files.Length > 0) files += ",";
            files += "{\"path\":\"" + file + "\",\"sha256\":\"" + hash + "\"}";
        }
        for (int number = 2; number <= Math.Min(version, Migrations.Length); number++)
        {
            if (number == omitMigration) continue;
            files += ",{\"path\":\"app/resources/migrations/versions/" + Migrations[number - 1] + "\",\"sha256\":\"" + hash + "\"}";
        }
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
        Check(Manifest.SupportedSchemaVersion == 23);
        for (int version = 1; version <= 23; version++)
        {
            int v = version;
            Check(Manifest.Parse(Json(v), true).SchemaVersion == v);
            if (v < 23) Reject(delegate { Manifest.Parse(Json(v)); });
            else Check(Manifest.Parse(Json(v)).SchemaVersion == v);
            for (int missing = 1; missing <= v; missing++)
            {
                int m = missing;
                Reject(delegate { Manifest.Parse(Json(v, m), true); });
            }
        }
        Reject(delegate { Manifest.Parse(Json(24), true); });
        Reject(delegate { Manifest.Parse(Json(0), true); });
        Reject(delegate { Manifest.Parse(Json(24).Replace("\"businessSchemaVersion\":24", "\"businessSchemaVersion\":\"24\"")); });
        Reject(delegate { Manifest.Parse(Json(23).Replace("\"product\":\"superstring\"", "\"product\":\"other\"")); });
        Console.WriteLine("{\"passed\":" + passed + ",\"failed\":0}");
        return 0;
    }
}
