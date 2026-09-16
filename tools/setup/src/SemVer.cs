using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;

namespace Superstring.Setup
{
    /// <summary>
    /// Strict SemVer 2.0.0 ordering, matching tools/installer/upgrade-policy.mjs.
    /// Upgrade decisions must never fall back to string comparison.
    /// </summary>
    internal static class SemVer
    {
        private sealed class Parsed
        {
            internal long Major, Minor, Patch;
            internal bool IsPrerelease;
            internal List<string> Prerelease = new List<string>();
        }

        internal static bool IsValid(string text)
        {
            Parsed ignored;
            return TryParse(text, out ignored);
        }

        internal static int Compare(string left, string right)
        {
            Parsed a, b;
            if (!TryParse(left, out a)) throw new InvalidDataException("INVALID_VERSION: " + left);
            if (!TryParse(right, out b)) throw new InvalidDataException("INVALID_VERSION: " + right);
            for (int i = 0; i < 3; i++)
            {
                long x = i == 0 ? a.Major : i == 1 ? a.Minor : a.Patch;
                long y = i == 0 ? b.Major : i == 1 ? b.Minor : b.Patch;
                if (x != y) return x < y ? -1 : 1;
            }
            if (!a.IsPrerelease || !b.IsPrerelease)
            {
                if (a.IsPrerelease == b.IsPrerelease) return 0;
                return a.IsPrerelease ? -1 : 1;
            }
            int max = Math.Max(a.Prerelease.Count, b.Prerelease.Count);
            for (int i = 0; i < max; i++)
            {
                if (i >= a.Prerelease.Count) return -1;
                if (i >= b.Prerelease.Count) return 1;
                string x = a.Prerelease[i], y = b.Prerelease[i];
                if (x == y) continue;
                bool nx = IsNumeric(x), ny = IsNumeric(y);
                if (nx && ny) return CompareNumeric(x, y);
                if (nx != ny) return nx ? -1 : 1;
                return string.CompareOrdinal(x, y) < 0 ? -1 : 1;
            }
            return 0;
        }

        private static bool IsNumeric(string value)
        {
            if (value.Length == 0) return false;
            foreach (char c in value) if (c < '0' || c > '9') return false;
            return true;
        }

        private static int CompareNumeric(string left, string right)
        {
            // Avoid decimal.Parse overflow by comparing significant digits first.
            string a = left.TrimStart('0'), b = right.TrimStart('0');
            if (a.Length != b.Length) return a.Length < b.Length ? -1 : 1;
            int order = string.CompareOrdinal(a, b);
            return order == 0 ? 0 : (order < 0 ? -1 : 1);
        }

        private static bool TryParse(string text, out Parsed parsed)
        {
            parsed = null;
            if (string.IsNullOrEmpty(text)) return false;
            string core = text;
            string prerelease = null;
            int plus = core.IndexOf('+');
            if (plus >= 0) core = core.Substring(0, plus); // build metadata never affects order
            int dash = core.IndexOf('-');
            if (dash >= 0)
            {
                prerelease = core.Substring(dash + 1);
                core = core.Substring(0, dash);
            }
            string[] parts = core.Split('.');
            if (parts.Length != 3) return false;
            long[] numbers = new long[3];
            for (int i = 0; i < 3; i++)
            {
                string part = parts[i];
                if (part.Length == 0 || (part.Length > 1 && part[0] == '0')) return false;
                long value;
                if (!long.TryParse(part, NumberStyles.None, CultureInfo.InvariantCulture, out value)) return false;
                numbers[i] = value;
            }
            var result = new Parsed { Major = numbers[0], Minor = numbers[1], Patch = numbers[2] };
            if (prerelease != null)
            {
                if (prerelease.Length == 0) return false;
                foreach (string identifier in prerelease.Split('.'))
                {
                    if (identifier.Length == 0) return false;
                    foreach (char c in identifier)
                        if (!(char.IsLetterOrDigit(c) || c == '-')) return false;
                    if (IsNumeric(identifier) && identifier.Length > 1 && identifier[0] == '0') return false;
                    result.Prerelease.Add(identifier);
                }
                result.IsPrerelease = true;
            }
            parsed = result;
            return true;
        }

        /// <summary>Throws on downgrade; returns "upgrade" or "same-version-reinstall".</summary>
        internal static string Classify(string currentVersion, string incomingVersion)
        {
            int order = Compare(incomingVersion, currentVersion);
            if (order < 0) throw new InvalidDataException("DOWNGRADE_REJECTED");
            return order == 0 ? "same-version-reinstall" : "upgrade";
        }
    }
}
