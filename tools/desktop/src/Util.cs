using System;
using System.Security.Cryptography;
using System.Text;

namespace Superstring.Desktop
{
    internal static class Util
    {
        /// <summary>
        /// Generate a cryptographically random hex string of byteCount*2 characters.
        /// The desktop token is 32 bytes -> 64 hex chars per the contract.
        /// </summary>
        public static string RandomHex(int byteCount)
        {
            using (var rng = new RNGCryptoServiceProvider())
            {
                byte[] b = new byte[byteCount];
                rng.GetBytes(b);
                var sb = new StringBuilder(byteCount * 2);
                foreach (byte x in b) sb.Append(x.ToString("x2"));
                return sb.ToString();
            }
        }

        public static bool IsHex(string s)
        {
            if (string.IsNullOrEmpty(s)) return false;
            foreach (char c in s)
            {
                if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return false;
            }
            return true;
        }
    }
}
