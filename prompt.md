# Zadanie: zaimplementuj `codex-usage-guard` dla planów Plus/Pro oraz Business/Enterprise

Zaimplementuj kompletną lokalną aplikację CLI o nazwie `codex-usage-guard`, działającą jako globalny hook OpenAI Codex i chroniącą użytkownika przed zbyt szybkim wykorzystaniem dostępnego limitu.

Aplikacja ma wspierać dwa niezależne modele rozliczania:

1. **Plus/Pro** — tygodniowy limit usage rozliczany procentowo w oknie około 7 dni.
2. **Business/Enterprise** — miesięczny limit AI Credits rozliczany proporcjonalnie na dni robocze.

Projekt ma być jedną aplikacją z dwiema strategiami pacingu, a nie dwoma osobnymi repozytoriami.

Hook ma być uruchamiany przed wysłaniem każdego promptu użytkownika.

Nie twórz wyłącznie prototypu ani pojedynczego skryptu. Przygotuj działające, testowalne narzędzie gotowe do codziennego używania.

---

# 1. Środowiska docelowe

## Plus/Pro

Wspierane platformy:

```text
macOS arm64
macOS x86_64
Linux arm64
Linux x86_64
```

## Business/Enterprise

Wspierane platformy:

```text
macOS arm64
macOS x86_64
Linux arm64
Linux x86_64
```

Kod może być wspólny dla wszystkich platform. Strategia Business/Enterprise ma działać na macOS i Linuxie; nie może być sztucznie zależna od macOS.

Na jednym urządzeniu użytkownik korzysta tylko z jednego rodzaju subskrypcji. Nie trzeba wspierać jednoczesnego aktywnego konta prywatnego i firmowego.

---

# 2. Technologia

Zaimplementuj projekt w:

```text
TypeScript
Bun
```

Wymagania:

- TypeScript z włączonym `strict`;
- ESM;
- przypięta konkretna wersja Bun;
- szybki startup odpowiedni dla hooka uruchamianego przed każdym promptem;
- kompilacja do samodzielnych executable przez `bun build --compile`;
- brak wymagania instalacji Node.js, npm lub Bun na urządzeniu końcowym;
- SQLite przez `bun:sqlite`;
- `Bun.spawn` do komunikacji z `codex app-server`;
- `decimal.js` lub równoważna biblioteka do precyzyjnych obliczeń AI Credits;
- `@js-temporal/polyfill` albo równoważne rozwiązanie dla miesięcy kalendarzowych, lokalnych północy, stref czasowych i DST;
- Zod albo równoważna walidacja runtime odpowiedzi App Servera;
- `bun:test` do testów;
- brak zależności od `jq`, GNU `date`, GNU `sed`, Bash-only lub Homebrew-only;
- brak dodatków wymagających `node-gyp`.

Bun-specyficzne API ogranicz do warstw infrastrukturalnych:

```text
bun:sqlite
Bun.spawn
Bun build --compile
bun:test
```

Logika domenowa i strategie pacingu mają pozostać czystym TypeScriptem.

---

# 3. Anonimizacja danych

Wszystkie przykłady, fixtures, testy, dokumentacja i logi demonstracyjne muszą używać wyłącznie danych syntetycznych.

Nie kopiuj do repozytorium rzeczywistych wartości pochodzących z konta użytkownika, w tym:

- rzeczywistego miesięcznego limitu AI Credits;
- rzeczywistego zużycia;
- rzeczywistego procentu pozostałego limitu;
- rzeczywistego czasu resetu;
- identyfikatorów konta, workspace lub organizacji;
- adresów e-mail;
- tokenów uwierzytelniających;
- cookies;
- lokalnych nazw użytkowników;
- bezwzględnych ścieżek z urządzenia użytkownika;
- nazw firmy;
- rzeczywistych liczb tokenów;
- innych danych, które mogłyby umożliwić identyfikację użytkownika lub organizacji.

Dla przykładów Business/Enterprise używaj domyślnie syntetycznych wartości:

```text
monthly limit:       1000 AI Credits
used:                 420.5 AI Credits
remainingPercent:      58
```

Dla Plus/Pro używaj prostych, syntetycznych wartości:

```text
weekly usage:          40%
linear schedule:       35%
ahead:                  8h 24m
```

Fixtures mogą zachowywać rzeczywistą strukturę odpowiedzi Codex App Servera, ale wszystkie wartości muszą być syntetyczne.

---

# 4. Architektura strategii

Zaprojektuj wspólny interfejs strategii pacingu.

Przykładowo:

```ts
interface PacingStrategy<TInput, TResult> {
  evaluate(input: TInput): TResult;
}
```

Wymagane implementacje:

```text
WeeklyPercentagePacingStrategy
MonthlyAiCreditsWorkdaysStrategy
```

Wspólne elementy:

- globalny hook;
- CLI;
- klient Codex App Servera;
- parser rate limits;
- cache;
- SQLite;
- wykrywanie resetów;
- override’y;
- komunikaty allow/warn/block;
- instalacja i odinstalowanie hooka;
- diagnostyka;
- logowanie;
- build i dystrybucja.

Różnice:

```text
Plus/Pro:
- limit procentowy;
- okno około 7 dni;
- jednostka wyprzedzenia: czas;
- domyślna blokada: 24h ahead;
- extend: +24h.

Business/Enterprise:
- limit AI Credits;
- okres miesięczny;
- budżet przydzielany na dni poniedziałek–piątek;
- jednostka wyprzedzenia: dni robocze;
- domyślna blokada: 1 workday ahead;
- extend: +1 workday.
```

---

# 5. Najpierw zweryfikuj aktualne API Codexa

Przed implementacją sprawdź aktualną oficjalną dokumentację i kod źródłowy OpenAI Codex CLI.

Zweryfikuj:

1. Jak skonfigurować globalny hook uruchamiany przed wysłaniem promptu użytkownika.
2. Jak dokładnie nazywa się hook.
3. Jaki payload otrzymuje hook.
4. Jak hook ma:
   - przepuścić prompt bez komunikatu;
   - przepuścić prompt i pokazać warning;
   - zablokować prompt i pokazać powód.
5. Czy warning jest wyświetlany jako UI/system message, czy trafia do kontekstu modelu.
6. Jak globalna konfiguracja hooków jest przechowywana na macOS i Linuxie.
7. Jak uruchomić `codex app-server`.
8. Jaki handshake jest wymagany.
9. Jak wywołać `account/rateLimits/read`.
10. Czy istnieje event aktualizacji rate limits.
11. Czy hook może bezpiecznie uruchomić oddzielny proces App Servera.
12. Czy istnieje stabilniejsza metoda odczytu danych używanych przez `/status`.
13. Jak zachować inne istniejące hooki użytkownika.
14. Jak pokazać warning bez blokowania.
15. Jak zablokować wyłącznie prompt bez zamykania rozmowy.
16. Czy treść zablokowanego promptu pozostaje dostępna użytkownikowi do ponownej edycji lub wysłania.

Nie zakładaj, że formaty opisane w tym promptcie są identyczne z aktualnym Codexem.

Jeżeli rzeczywisty kontrakt różni się od założeń:

- dostosuj implementację;
- nie symuluj nieistniejącego API;
- opisz różnice w dokumentacji.

Zapisz wyniki w:

```text
docs/codex-integration.md
```

Dokument ma zawierać:

- testowaną wersję Codex CLI;
- rzeczywisty kontrakt hooka;
- rzeczywisty kontrakt App Servera;
- handshake;
- sposób prezentacji warningu;
- sposób blokowania promptu;
- zanonimizowane przykładowe odpowiedzi;
- znane ograniczenia.

---

# 6. Odczyt danych z Codex App Servera

Preferowanym źródłem danych ma być:

```text
account/rateLimits/read
```

## Syntetyczna odpowiedź Business/Enterprise

Przykładowa struktura:

```json
{
  "id": 2,
  "result": {
    "rateLimits": {
      "limitId": "codex",
      "limitName": null,
      "primary": null,
      "secondary": null,
      "credits": {
        "hasCredits": true,
        "unlimited": false,
        "balance": null
      },
      "individualLimit": {
        "limit": "1000",
        "used": "420.5",
        "remainingPercent": 58,
        "resetsAt": 1790812800
      },
      "spendControlReached": false,
      "planType": "business",
      "rateLimitReachedType": null
    },
    "rateLimitsByLimitId": {
      "codex": {
        "limitId": "codex",
        "limitName": null,
        "primary": null,
        "secondary": null,
        "credits": {
          "hasCredits": true,
          "unlimited": false,
          "balance": null
        },
        "individualLimit": {
          "limit": "1000",
          "used": "420.5",
          "remainingPercent": 58,
          "resetsAt": 1790812800
        },
        "spendControlReached": false,
        "planType": "business",
        "rateLimitReachedType": null
      }
    },
    "rateLimitResetCredits": {
      "availableCount": 0,
      "credits": []
    }
  }
}
```

Dla Business/Enterprise korzystaj z:

```text
rateLimits.individualLimit.limit
rateLimits.individualLimit.used
rateLimits.individualLimit.remainingPercent
rateLimits.individualLimit.resetsAt
rateLimits.planType
rateLimits.limitId
rateLimits.spendControlReached
rateLimits.credits.unlimited
rateLimitResetCredits
```

`limit` i `used` są stringami dziesiętnymi.

Nie parsuj ich jako JavaScript `number`.

Używaj `Decimal` dla wszystkich decyzji kredytowych.

## Plus/Pro

Dla Plus/Pro oczekiwane są dane odpowiadające tygodniowemu oknu, przykładowo:

```json
{
  "secondary": {
    "usedPercent": 40,
    "windowDurationMins": 10080,
    "resetsAt": 1790812800
  }
}
```

Rzeczywiste nazwy pól mogą używać snake_case albo camelCase.

Wprowadź adapter normalizujący dane do wspólnego modelu:

```ts
interface WeeklyLimitSnapshot {
  usedPercent: Decimal;
  windowDurationSeconds: number;
  resetsAt: Temporal.Instant;
  observedAt: Temporal.Instant;
  source: string;
}
```

Tygodniowe okno identyfikuj głównie po długości zbliżonej do:

```text
10080 minut
7 dni
604800 sekund
```

Nie zakładaj bezwarunkowo, że:

```text
secondary zawsze oznacza tydzień
```

Jeżeli App Server nie zwróci tygodniowego limitu, dodaj fallback do najnowszych lokalnych zdarzeń sesji Codexa, jeśli zawierają:

```text
used_percent
window_minutes
resets_at
```

Fallback ma być wyraźnie oznaczony jako mniej świeży.

---

# 7. Automatyczny wybór profilu

Domyślnie:

```toml
active_profile = "auto"
```

Obsługuj:

```toml
active_profile = "auto"
active_profile = "personal"
active_profile = "work"
```

## Profil firmowy

Wybierz `work`, jeżeli:

```text
individualLimit istnieje
OR
planType wskazuje business/enterprise
```

i `individualLimit` zawiera poprawne:

```text
limit
used
resetsAt
```

## Profil prywatny

Wybierz `personal`, jeżeli:

```text
brak individualLimit
AND
istnieje procentowy limit z oknem około 7 dni
```

## Niejednoznaczność

Jeżeli oba modele są dostępne:

1. preferuj profil jawnie ustawiony w konfiguracji;
2. w trybie `auto` preferuj `individualLimit`, jeżeli plan jest Business/Enterprise;
3. pokaż w `doctor` i `status`, dlaczego wybrano daną strategię.

Jeżeli nie można ustalić profilu:

- zastosuj `missing_data_action`;
- nie zgaduj na podstawie samej nazwy planu.

---

# 8. Profil Plus/Pro — tygodniowy pacing procentowy

## Cel

Zużycie tygodniowego limitu ma podążać za liniowym harmonogramem.

Definicje:

```text
window_start = resets_at - window_duration
elapsed = now - window_start
usage_position = used_percent / 100 × window_duration
ahead = usage_position - elapsed
```

Interpretacja:

```text
ahead <= 0
→ użytkownik nie wyprzedza harmonogramu

ahead > 0
→ użytkownik zużywa limit szybciej niż harmonogram

ahead >= effective_lead_limit
→ zablokuj kolejny prompt
```

## Domyślne ustawienia

```text
base_lead_limit = 24h
warning_threshold = 0h
extension_step = 24h
```

## Warning

Warning ma być pokazywany dla każdego:

```text
ahead > 0
```

Przykład:

```text
Codex weekly usage warning

Weekly usage:          40.0%
Linear schedule:       35.0%
Ahead of schedule:      8h 24m
Blocking threshold:    24h

The prompt was allowed.
```

## Blokada

Blokuj, gdy:

```text
ahead >= effective_lead_limit
```

Gdzie:

```text
effective_lead_limit =
    base_lead_limit
    + temporary_extension
```

Przykład:

```text
Codex weekly usage guard blocked this prompt

Weekly usage:          50.0%
Linear schedule:       34.0%
Ahead of schedule:     26h 53m
Allowed lead:          24h

Estimated unlock:
2026-10-02 18:00 local time

Temporary extension:
  codex-usage-guard extend

Disable blocking until reset:
  codex-usage-guard unlock
```

## Czas odblokowania

Oblicz:

```text
unlock_at =
    window_start
    + usage_position
    - effective_lead_limit
```

Jeżeli `unlock_at <= now`, nie pokazuj przyszłej daty.

## Extend

```bash
codex-usage-guard extend
```

Dla profilu prywatnego każde wykonanie dodaje:

```text
24h
```

Przykład:

```text
bazowy limit: 24h
po jednym extend: 48h
po dwóch extend: 72h
```

Obsłuż:

```bash
codex-usage-guard extend 2
```

co oznacza:

```text
+48h
```

Opcjonalnie obsłuż:

```bash
codex-usage-guard extend 12h
codex-usage-guard extend 2d
```

ale nie jest to wymagane dla pierwszej wersji.

---

# 9. Profil Business/Enterprise — miesięczne AI Credits

## Cel

Miesięczny limit AI Credits ma być rozłożony równomiernie na dni robocze bieżącego okresu.

Dni robocze:

```text
poniedziałek
wtorek
środa
czwartek
piątek
```

Nie obsługuj świąt państwowych ani firmowych.

Sobota i niedziela nie zwiększają dostępnego budżetu.

Każdego dnia roboczego pełna dzienna część budżetu staje się dostępna na początku lokalnego dnia.

Nie stosuj płynnego naliczania w ciągu dnia.

Nie konfiguruj godzin pracy.

## Przykład

```text
limit: 1000 credits
liczba dni roboczych: 20
daily budget: 50 credits
```

Na początku ósmego dnia roboczego:

```text
scheduled_credits = 400
```

Cały budżet dnia jest dostępny od lokalnej północy.

---

# 10. Business/Enterprise — wyznaczanie okresu

Backend zwraca:

```text
resetsAt
```

Nie musi zwracać:

```text
startsAt
```

## Preferowane źródło początku

Jeżeli aplikacja widziała poprzednią epokę:

```text
period_start = previous_resets_at
period_end = current_resets_at
```

## Pierwsze uruchomienie

Jeżeli nie ma historii:

1. potraktuj `resetsAt` jako koniec bieżącego okresu;
2. odejmij jeden miesiąc kalendarzowy;
3. wykonaj operację w UTC;
4. nie odejmuj stałych 30 dni;
5. zachowaj dzień i godzinę resetu;
6. poprawnie obsłuż miesiące o różnej długości.

Syntetyczne przykłady:

```text
2026-11-01 00:00 UTC → 2026-10-01 00:00 UTC
2027-03-01 00:00 UTC → 2027-02-01 00:00 UTC
2027-01-01 00:00 UTC → 2026-12-01 00:00 UTC
2026-11-15 10:30 UTC → 2026-10-15 10:30 UTC
```

Po zaobserwowaniu rzeczywistego następnego resetu używaj zapisanych granic serwerowych.

---

# 11. Business/Enterprise — dni robocze

Strefa czasowa:

```toml
timezone = "system"
```

Można wymusić:

```toml
timezone = "Europe/Warsaw"
```

`resetsAt` traktuj jako Unix timestamp UTC.

Dni robocze i lokalne północe licz w lokalnej strefie użytkownika.

Zaimplementuj:

```text
total_workdays
started_workdays
```

## `total_workdays`

Liczba lokalnych dat poniedziałek–piątek, których początek dnia znajduje się w:

```text
[period_start, period_end)
```

## `started_workdays`

Liczba takich dni, których lokalny początek już nastąpił.

W weekend:

```text
started_workdays nie rośnie
```

W poniedziałek o lokalnej północy:

```text
started_workdays zwiększa się o 1
```

Jeżeli okres zaczyna się w środku lokalnego dnia:

- nie przyznawaj pełnego budżetu za dzień, którego lokalna północ była przed `period_start`;
- zaliczaj tylko dni, których lokalny początek znajduje się wewnątrz okresu;
- udokumentuj tę regułę.

---

# 12. Business/Enterprise — obliczenia

Użyj precyzyjnej arytmetyki dziesiętnej.

```text
daily_budget =
    monthly_limit / total_workdays
```

```text
scheduled_credits =
    monthly_limit
    × started_workdays
    / total_workdays
```

Preferuj drugi wzór dla wartości harmonogramu, aby nie kumulować zaokrągleń.

```text
ahead_credits =
    used_credits - scheduled_credits
```

```text
ahead_workdays =
    ahead_credits / daily_budget
```

Nie zaokrąglaj wartości pośrednich.

Do UI można zaokrąglać, ale decyzje muszą korzystać z pełnej precyzji `Decimal`.

Syntetyczny przykład:

```text
monthly limit:          1000
total workdays:           20
started workdays:          8
daily budget:             50
scheduled credits:       400
used credits:          420.5
ahead credits:          20.5
ahead workdays:         0.41
```

---

# 13. Business/Enterprise — warning i blokada

Domyślne ustawienia:

```text
warning od pierwszego przekroczenia harmonogramu
block po wejściu o 1 pełny dzień roboczy w przyszłość
extension step = 1 workday
```

Reguły:

```text
ahead_workdays <= 0
→ allow bez warningu

0 < ahead_workdays < effective_block_lead
→ allow z warningiem

ahead_workdays >= effective_block_lead
→ block
```

Domyślnie:

```text
base_block_lead = 1 workday
```

Efektywny limit:

```text
effective_block_lead =
    base_block_lead
    + temporary_extension_workdays
```

## Warning

```text
Codex AI Credits usage warning

Monthly credit limit:     1,000
Credits used:               420.50
Scheduled by now:           400.00
Ahead of schedule:           20.50 credits
Equivalent lead:              0.41 workday
Blocking threshold:           1.00 workday

The prompt was allowed.
```

## Blokada

```text
Codex AI Credits usage guard blocked this prompt

Monthly credit limit:     1,000
Credits used:               475.00
Scheduled by now:           400.00
Ahead of schedule:           75.00 credits
Equivalent lead:              1.50 workdays
Allowed lead:                 1.00 workday

Next daily budget release:
Monday, 5 October 2026 at 00:00 local time

Estimated return below the blocking threshold:
Tuesday, 6 October 2026 at 00:00 local time

Temporary extension:
  codex-usage-guard extend

Disable blocking until reset:
  codex-usage-guard unlock
```

---

# 14. Business/Enterprise — wyliczanie odblokowania

Budżet jest przyznawany skokowo na początku dnia roboczego.

Nie podawaj płynnego czasu odblokowania w środku dnia.

Znajdź najbliższą przyszłą lokalną północ dnia roboczego, po której:

```text
used_credits
<
scheduled_credits_at_that_day
+
effective_lead_credits
```

Gdzie:

```text
effective_lead_credits =
    effective_block_lead_workdays
    × daily_budget
```

Przeszukuj kolejne dni robocze aż do:

- znalezienia odblokowania;
- albo końca okresu.

Jeżeli odblokowanie nastąpi dopiero po resecie, pokaż czas resetu.

---

# 15. Wspólna komenda `extend`

```bash
codex-usage-guard extend
```

Zachowanie zależy od aktywnego profilu.

## Plus/Pro

```text
+24h do maksymalnego wyprzedzenia
```

## Business/Enterprise

```text
+1 workday do maksymalnego wyprzedzenia
```

Rozszerzenia są kumulatywne.

Przykład Business:

```text
bazowy limit: 1 workday
po pierwszym extend: 2 workdays
po drugim extend: 3 workdays
```

Przykład Plus/Pro:

```text
bazowy limit: 24h
po pierwszym extend: 48h
po drugim extend: 72h
```

Obsłuż:

```bash
codex-usage-guard extend 2
```

Znaczenie:

```text
Plus/Pro: +48h
Business/Enterprise: +2 workdays
```

Status i wynik komendy muszą jasno pokazywać jednostkę.

Override obowiązuje wyłącznie do resetu bieżącego okresu.

---

# 16. Wspólna komenda `unlock`

Zaimplementuj:

```bash
codex-usage-guard unlock
```

oraz:

```bash
codex-usage-guard unlock --until-reset
```

W trybie unlock:

- prompt zawsze przechodzi;
- warning nadal jest pokazywany, gdy usage wyprzedza harmonogram;
- status pokazuje, że blokowanie jest czasowo wyłączone;
- override jest przypięty do bieżącej epoki;
- override automatycznie wygasa po resecie.

Po resecie:

```text
unlocked_until_reset = false
```

---

# 17. Reset override’ów

Zaimplementuj:

```bash
codex-usage-guard reset-overrides
```

Komenda usuwa:

```text
temporary extension
unlocked_until_reset
```

Nie modyfikuje danych serwerowych.

Nie symuluje resetu quota.

---

# 18. Wykrywanie resetów

Override’y muszą być przypięte do konkretnej epoki limitu.

Po wykryciu nowej epoki:

```text
temporary extension = 0
unlocked_until_reset = false
```

## Plus/Pro

Pewny reset:

```text
new.resetsAt > previous.resetsAt
```

lub pojawiło się nowe okno o nowym `window_start`.

Dodatkowy sygnał:

```text
new.usedPercent jest istotnie mniejsze od previous.usedPercent
```

Nie wymagaj zobaczenia dokładnie `0%`.

## Business/Enterprise

Pewny reset:

```text
new.resetsAt > previous.resetsAt
```

Nowa epoka:

```text
period_start = previous.resetsAt
period_end = new.resetsAt
```

## Wcześniejsze resety lub korekty OpenAI

OpenAI może obniżyć usage przed planowanym resetem.

Dla obu profili:

1. wykryj istotny spadek;
2. wykonaj drugi świeży odczyt;
3. upewnij się, że dane nie pochodzą ze starego cache;
4. sprawdź zmianę `resetsAt`;
5. sprawdź `window_start`;
6. sprawdź `rateLimitResetCredits`;
7. zapisz zdarzenie diagnostyczne.

Konfiguracja:

```toml
[reset_detection]
weekly_used_percent_drop_threshold = "1.0"
business_used_credits_drop_threshold = "1.0"
confirmation_reads = 2
confirmation_interval = "2s"
```

Jeżeli spadek jest bardzo duży i potwierdzony, można uznać lokalną wcześniejszą epokę nawet przy niezmienionym `resetsAt`.

Syntetyczne przykłady:

```text
Business:
previous used = 800
new used = 50

Plus/Pro:
previous used = 80%
new used = 5%
```

W takim przypadku:

- zresetuj override’y;
- zachowaj serwerowy koniec okresu;
- zapisz `observed_period_start`;
- oznacz epokę jako `early_reset_inferred`;
- zapisz poprzednie i nowe wartości.

Małe spadki mogą być korektą albo efektem niespójnych snapshotów. Nie resetuj override’ów na podstawie pojedynczej drobnej zmiany.

---

# 19. Zmiana limitu Business/Enterprise

Jeżeli:

```text
resetsAt bez zmian
limit wzrósł
```

to:

- nie traktuj tego jako resetu;
- nie usuwaj override’ów;
- nie zeruj usage;
- przelicz cały harmonogram proporcjonalnie według nowego limitu.

Syntetyczny przykład:

```text
wykonano 40% dni roboczych

stary limit = 1000
scheduled = 400

nowy limit = 1500
scheduled = 600
```

Dodatkowy proporcjonalny budżet ma stać się dostępny natychmiast.

Jeżeli limit zmaleje:

- również przelicz harmonogram;
- nie zmieniaj `used`;
- wynik może natychmiast stać się warningiem lub blokadą.

Zapisz:

```text
limit_changed
previous_limit
new_limit
resets_at
observed_at
```

---

# 20. Wyczerpanie serwerowego limitu

Dla Business/Enterprise zablokuj niezależnie od lokalnego pacingu, jeżeli:

```text
spendControlReached = true
```

lub:

```text
remainingPercent = 0
```

lub:

```text
used >= limit
```

Komunikat ma jasno mówić, że blokada pochodzi z limitu serwerowego, nie z lokalnego pacingu.

Jeżeli:

```text
credits.unlimited = true
```

to:

- lokalny miesięczny pacing nie ma zastosowania;
- prompt przechodzi;
- `status` pokazuje unlimited;
- nie próbuj dzielić budżetu na dni.

Dla Plus/Pro respektuj analogiczne serwerowe informacje o całkowitym osiągnięciu limitu.

---

# 21. Cache i świeżość danych

Konfiguracja:

```toml
[data]
cache_ttl = "60s"
maximum_stale_age = "15m"
app_server_timeout = "5s"
missing_data_action = "warn"
fallback_to_session_files = true
```

Zasady:

```text
cache młodszy niż cache_ttl
→ użyj cache

cache starszy niż cache_ttl
→ spróbuj świeżego odczytu

świeży odczyt nie działa
→ użyj cache, jeśli nie przekroczył maximum_stale_age

cache za stary
→ zastosuj missing_data_action
```

Dozwolone wartości:

```text
allow
warn
block
```

Domyślnie:

```text
warn
```

## `allow`

- prompt przechodzi;
- problem trafia do logu.

## `warn`

- prompt przechodzi;
- użytkownik widzi, że guard nie mógł zweryfikować limitu.

## `block`

- prompt zostaje zablokowany;
- komunikat wyjaśnia problem z danymi.

Cache przechowuj osobno dla typu danych i epoki.

---

# 22. CLI

Wymagane komendy:

```text
codex-usage-guard status
codex-usage-guard check
codex-usage-guard check --json
codex-usage-guard extend
codex-usage-guard extend 2
codex-usage-guard unlock
codex-usage-guard unlock --until-reset
codex-usage-guard reset-overrides
codex-usage-guard install-hook
codex-usage-guard uninstall-hook
codex-usage-guard doctor
codex-usage-guard config-path
codex-usage-guard state-path
codex-usage-guard profile
```

## `profile`

```bash
codex-usage-guard profile
```

Pokazuje:

- wykryty plan;
- wybraną strategię;
- powód wyboru;
- dostępne źródła danych.

Opcjonalnie:

```bash
codex-usage-guard profile personal
codex-usage-guard profile work
codex-usage-guard profile auto
```

Zmienia lokalną konfigurację profilu.

## Kody wyjścia `check`

```text
0  = allow bez warningu
10 = allow z warningiem
20 = block
30 = brak wiarygodnych danych
40 = błąd konfiguracji
50 = błąd integracji z Codex App Serverem
```

Adapter hooka tłumaczy wynik na rzeczywisty kontrakt Codexa.

---

# 23. Status

`status` ma pokazywać wspólną sekcję oraz dane zależne od profilu.

## Wspólne

```text
Detected plan
Active profile
Selected strategy
Data source
Last successful read
Cache freshness
Decision
Blocking enabled
Unlocked until reset
Quota epoch
Last reset
```

## Plus/Pro — syntetyczny przykład

```text
Plan:                     Pro
Strategy:                 weekly_percentage_pacing

Weekly usage:             40.0%
Window start:             2026-09-25 12:00 local
Window end:               2026-10-02 12:00 local
Time until reset:         3d 18h

Linear schedule:          35.0%
Ahead of schedule:        8h 24m

Base allowed lead:        24h
Temporary extension:      24h
Effective allowed lead:   48h
Unlocked until reset:     no

Decision:                 WARNING
```

## Business/Enterprise — syntetyczny przykład

```text
Plan:                     Business
Strategy:                 monthly_ai_credits_workdays
Limit ID:                 codex

Monthly credit limit:     1,000
Credits used:               420.5000
Credits remaining:          579.5000
Remaining percent:        58%

Period start:             2026-10-01 02:00 local
Period end:               2026-11-01 01:00 local
Time until reset:         9d 11h

Total workdays:           20
Started workdays:          8
Daily budget:             50.0000
Scheduled by now:        400.0000

Ahead of schedule:        20.5000 credits
Equivalent lead:           0.41 workday

Base allowed lead:         1 workday
Temporary extension:       0 workdays
Effective allowed lead:    1 workday
Unlocked until reset:      no

Decision:                 WARNING
```

---

# 24. JSON z `check --json`

Zwracaj ujednolicony model z polem strategii.

## Plus/Pro

```json
{
  "decision": "warn",
  "profile": "personal",
  "strategy": "weekly_percentage_pacing",
  "usedPercent": "40",
  "scheduledPercent": "35",
  "aheadSeconds": 30240,
  "baseLeadSeconds": 86400,
  "temporaryExtensionSeconds": 0,
  "effectiveLeadSeconds": 86400,
  "unlockedUntilReset": false,
  "periodEnd": "2026-10-02T10:00:00Z",
  "estimatedUnlock": "2026-09-30T18:00:00+02:00"
}
```

## Business/Enterprise

```json
{
  "decision": "warn",
  "profile": "work",
  "strategy": "monthly_ai_credits_workdays",
  "limitCredits": "1000",
  "usedCredits": "420.5",
  "scheduledCredits": "400",
  "aheadCredits": "20.5",
  "aheadWorkdays": "0.41",
  "baseLeadWorkdays": 1,
  "temporaryExtensionWorkdays": 0,
  "effectiveLeadWorkdays": 1,
  "unlockedUntilReset": false,
  "periodEnd": "2026-11-01T00:00:00Z",
  "nextBudgetRelease": "2026-10-05T00:00:00+02:00"
}
```

Wartości kredytowe serializuj jako stringi dziesiętne.

---

# 25. Instalacja hooka

Zaimplementuj:

```bash
codex-usage-guard install-hook
```

Wymagania:

- globalny hook dla bieżącego użytkownika;
- brak roota;
- zachowanie istniejących hooków;
- brak nadpisywania cudzych wpisów;
- backup konfiguracji;
- idempotentność;
- walidacja po instalacji;
- pokazanie zmodyfikowanych plików;
- wsparcie macOS i Linux;
- włączenie feature flagi hooków tylko wtedy, gdy jest potrzebna;
- nie usuwaj innych ustawień Codexa.

Zaimplementuj:

```bash
codex-usage-guard uninstall-hook
```

Usuwa tylko wpisy utworzone przez aplikację.

---

# 26. Diagnostyka

Zaimplementuj:

```bash
codex-usage-guard doctor
```

Sprawdzenia:

1. `codex` jest w `PATH`.
2. Wersja Codex CLI.
3. `codex app-server` uruchamia się.
4. Handshake działa.
5. `account/rateLimits/read` działa.
6. Odpowiedź przechodzi walidację.
7. Można wykryć profil.
8. Dla Business istnieje poprawny `individualLimit`.
9. Dla Plus/Pro istnieje tygodniowe okno.
10. Fallback session files działa, jeżeli jest potrzebny.
11. Hook jest zainstalowany.
12. Hook ma poprawny format.
13. Katalog stanu jest zapisywalny.
14. SQLite działa.
15. WAL działa.
16. Uprawnienia plików są bezpieczne.
17. Strefa czasowa jest prawidłowa.
18. Można policzyć okres i pacing.
19. Dane nie są przeterminowane.
20. Aktualna wersja Codexa różni się lub nie różni od testowanej.
21. Bun executable zawiera wszystkie wymagane zależności.

---

# 27. Stan i SQLite

Użyj:

```ts
import { Database } from "bun:sqlite";
```

Konfiguracja:

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

Nie używaj ORM.

Wymagane właściwości:

- atomowe `extend`;
- transakcyjne resetowanie override’ów;
- brak lost update;
- odporność na kilka równoległych sesji Codexa;
- epoch-aware updates;
- migracje schematu;
- szybki odczyt hooka.

Przykładowe tabele:

```text
settings
quota_epochs
usage_snapshots
overrides
reset_events
limit_change_events
cache_entries
```

Override musi być przypięty do:

```text
profile
strategy
epoch_id
```

Stary proces nie może nadpisać stanu nowej epoki.

---

# 28. Identyfikacja epoki

## Plus/Pro

`epoch_id` wyprowadź deterministycznie z:

```text
profile
limitId
windowDuration
windowStart
resetsAt
```

## Business/Enterprise

`epoch_id` wyprowadź z:

```text
profile
limitId
planType
periodStart
resetsAt
```

Jeżeli wystąpi `early_reset_inferred`, dodaj:

```text
observedPeriodStart
resetMethod
```

do identyfikacji lokalnej epoki.

---

# 29. Lokalizacje plików

## macOS

Konfiguracja:

```text
~/Library/Application Support/codex-usage-guard/config.toml
```

SQLite/state:

```text
~/Library/Application Support/codex-usage-guard/state.sqlite
```

Cache:

```text
~/Library/Caches/codex-usage-guard/
```

Logi:

```text
~/Library/Logs/codex-usage-guard/
```

## Linux

Konfiguracja:

```text
$XDG_CONFIG_HOME/codex-usage-guard/config.toml
```

Fallback:

```text
~/.config/codex-usage-guard/config.toml
```

Stan:

```text
$XDG_STATE_HOME/codex-usage-guard/state.sqlite
```

Fallback:

```text
~/.local/state/codex-usage-guard/state.sqlite
```

Cache:

```text
$XDG_CACHE_HOME/codex-usage-guard/
```

Fallback:

```text
~/.cache/codex-usage-guard/
```

Nie zapisuj stanu w katalogach projektów.

W `~/.codex` zapisuj tylko minimalną konfigurację hooka wymaganą przez Codex.

---

# 30. Konfiguracja TOML

Przykład:

```toml
active_profile = "auto"

[personal]
strategy = "weekly_percentage_pacing"
base_lead = "24h"
warning_after = "0h"
extension_step = "24h"

[work]
strategy = "monthly_ai_credits_workdays"
timezone = "system"
workdays = ["mon", "tue", "wed", "thu", "fri"]
budget_release = "start_of_day"
warning_after_workdays_ahead = 0
block_after_workdays_ahead = 1
extension_step_workdays = 1

[overrides]
reset_on_quota_reset = true
warning_during_unlock = true

[data]
source = "codex_app_server"
fallback_to_session_files = true
cache_ttl = "60s"
maximum_stale_age = "15m"
app_server_timeout = "5s"
missing_data_action = "warn"

[reset_detection]
weekly_used_percent_drop_threshold = "1.0"
business_used_credits_drop_threshold = "1.0"
confirmation_reads = 2
confirmation_interval = "2s"

[display]
timezone = "system"
credit_decimal_places = 2
percentage_decimal_places = 1
show_unlock_time = true
show_daily_budget = true
```

---

# 31. Prywatność i logi

Nie loguj:

- promptów;
- odpowiedzi modelu;
- treści rozmów;
- tokenów uwierzytelniających;
- cookies;
- pełnych e-maili;
- danych osobowych;
- stdin hooka poza bezpiecznymi polami technicznymi;
- lokalnych nazw użytkownika;
- pełnych ścieżek zawierających nazwę użytkownika.

Można logować:

- profil;
- strategię;
- decyzję allow/warn/block;
- procent usage;
- syntetyczne dane fixtures;
- rzeczywiste lokalne wartości usage wyłącznie w prywatnych logach runtime użytkownika;
- czasy resetów;
- wykrycie resetu;
- zmianę limitu;
- źródło danych;
- błędy App Servera;
- zmiany override’ów.

Zastosuj prostą rotację albo limit rozmiaru logów.

Pliki konfiguracji, SQLite i cache powinny mieć uprawnienia dostępne tylko dla użytkownika.

README, fixtures, snapshoty testowe i przykładowe logi nie mogą zawierać rzeczywistych danych runtime użytkownika.

---

# 32. Testy jednostkowe — wspólne

Dodaj testy dla:

1. allow bez warningu;
2. warning;
3. block dokładnie na progu;
4. unlock;
5. reset-overrides;
6. missing data allow;
7. missing data warn;
8. missing data block;
9. świeży cache;
10. stary cache;
11. timeout App Servera;
12. nieprawidłowy JSON;
13. nieprawidłowe dane;
14. równoległe `extend`;
15. zmiana epoki podczas równoległej operacji;
16. stary proces próbujący zapisać override;
17. migracja schematu SQLite;
18. wybór profilu auto;
19. ręczne wymuszenie personal;
20. ręczne wymuszenie work;
21. niejednoznaczne dane;
22. bezpieczne logowanie;
23. brak wycieku rzeczywistych danych do fixtures i snapshotów.

---

# 33. Testy Plus/Pro

Dodaj testy dla:

1. usage poniżej harmonogramu;
2. usage dokładnie na harmonogramie;
3. minimalne wyprzedzenie;
4. warning od `ahead > 0`;
5. block przy `ahead = 24h`;
6. block powyżej 24h;
7. `extend` do 48h;
8. dwa `extend` do 72h;
9. obliczenie unlock time;
10. planowy reset;
11. wcześniejszy reset;
12. mały niepotwierdzony spadek usage;
13. duży potwierdzony spadek;
14. brak dokładnego 0%;
15. zmiana `resetsAt`;
16. okno inne niż dokładnie 10080 minut;
17. odrzucenie okna 5h jako tygodniowego;
18. fallback do session files;
19. stary wpis sesji;
20. procent jako integer i decimal.

---

# 34. Testy Business/Enterprise

Dodaj testy dla:

1. usage poniżej harmonogramu;
2. usage dokładnie na harmonogramie;
3. minimalne przekroczenie;
4. warning od pierwszego przekroczenia;
5. block przy jednym dniu ahead;
6. pełny budżet przyznany na początku dnia;
7. brak płynnego naliczania;
8. sobota nie zwiększa budżetu;
9. niedziela nie zwiększa budżetu;
10. poniedziałek o północy zwiększa budżet;
11. okres z 20 dniami roboczymi;
12. okres z 21 dniami roboczymi;
13. okres z 22 dniami roboczymi;
14. okres z 23 dniami roboczymi;
15. luty;
16. rok przestępny;
17. DST wiosną;
18. DST jesienią;
19. okres nie od pierwszego dnia miesiąca;
20. pierwsze uruchomienie bez historii;
21. początek z poprzedniego `resetsAt`;
22. zwiększenie limitu;
23. zmniejszenie limitu;
24. `extend`;
25. dwa `extend`;
26. planowy reset;
27. wcześniejszy reset;
28. duży spadek `used`;
29. mały spadek `used`;
30. `spendControlReached`;
31. `used >= limit`;
32. `remainingPercent = 0`;
33. `unlimited = true`;
34. brak `individualLimit`;
35. nieprawidłowy Decimal;
36. odblokowanie po kolejnym workday;
37. odblokowanie dopiero po resecie;
38. zmiana limitu i reset w tym samym odczycie;
39. pełny dzienny budżet dostępny od lokalnej północy;
40. brak naliczania nowego budżetu w weekend.

---

# 35. Testy integracyjne

Dodaj syntetyczne fixtures i testy dla:

- handshake App Servera;
- parsera Plus/Pro;
- parsera Business/Enterprise;
- struktury `individualLimit`;
- fallbacku session files;
- adaptera hooka;
- warningu;
- blokady;
- instalacji hooka;
- idempotentnej instalacji;
- zachowania innych hooków;
- odinstalowania tylko własnego wpisu;
- timeoutu;
- cache;
- SQLite WAL;
- równoległych `extend`;
- resetu override’ów;
- executable zbudowanego przez Bun;
- macOS arm64;
- macOS x64;
- Linux arm64;
- Linux x64.

Fixtures nie mogą zawierać prywatnych danych.

Dodaj test lub prosty skrypt sprawdzający, czy repozytorium nie zawiera:

- rzeczywistych identyfikatorów;
- adresów e-mail;
- lokalnych nazw użytkowników;
- podejrzanie dokładnych wartości usage skopiowanych z lokalnego konta;
- pełnych lokalnych ścieżek.

---

# 36. Build i dystrybucja

Użyj:

```bash
bun build ./src/cli.ts --compile
```

Przygotuj executable:

```text
codex-usage-guard-darwin-arm64
codex-usage-guard-darwin-x64
codex-usage-guard-linux-arm64
codex-usage-guard-linux-x64
```

GitHub Actions:

- przypnij dokładną wersję Bun;
- uruchom formatowanie;
- uruchom lint;
- uruchom testy;
- zbuduj executable;
- uruchom smoke test executable;
- utwórz archiwa;
- wygeneruj SHA-256;
- nie publikuj release bez wyraźnego polecenia.

Dla dystrybucji firmowej można ograniczyć zakres artefaktów według potrzeb, ale implementacja wspiera macOS i Linux.

Opcjonalnie przygotuj:

- Homebrew formula;
- wewnętrzny tap;
- podpisywanie;
- notarization.

Nie uzależniaj działania aplikacji od Homebrew.

---

# 37. Sugerowana struktura projektu

```text
codex-usage-guard/
├── src/
│   ├── cli/
│   ├── domain/
│   ├── strategies/
│   │   ├── weekly-percentage.ts
│   │   └── monthly-workdays-credits.ts
│   ├── codex/
│   │   ├── app-server-client.ts
│   │   ├── rate-limits-parser.ts
│   │   ├── session-files-fallback.ts
│   │   └── hook-adapter.ts
│   ├── persistence/
│   │   ├── sqlite.ts
│   │   ├── migrations/
│   │   └── repositories/
│   ├── reset-detection/
│   ├── cache/
│   ├── config/
│   ├── platform/
│   ├── display/
│   └── logging/
├── tests/
├── fixtures/
├── docs/
│   └── codex-integration.md
├── .github/
│   └── workflows/
├── README.md
├── LICENSE
├── bun.lock
├── package.json
├── tsconfig.json
└── example-config.toml
```

---

# 38. README

README ma zawierać:

1. cel aplikacji;
2. opis obu profili;
3. informację, że Plus/Pro używa tygodniowego procentu;
4. informację, że Business/Enterprise używa AI Credits;
5. informację, że credits nie są estymowane z tokenów;
6. automatyczny wybór profilu;
7. wzory matematyczne obu strategii;
8. warning i block;
9. `extend`;
10. `unlock`;
11. reset override’ów;
12. wykrywanie resetów;
13. zwiększanie firmowego limitu;
14. dni robocze;
15. pełny budżet dnia o lokalnej północy;
16. zachowanie weekendów;
17. instalację na macOS;
18. instalację na Linuxie;
19. instalację hooka;
20. diagnostykę;
21. konfigurację;
22. prywatność i anonimizację;
23. build Bun;
24. samodzielne executable;
25. znane ograniczenia;
26. testowaną wersję Codexa;
27. testowaną wersję Bun;
28. sposób odinstalowania.

Wszystkie przykłady w README muszą używać danych syntetycznych.

---

# 39. Kolejność implementacji

Wykonaj pracę w tej kolejności:

1. Zweryfikuj hooki Codexa.
2. Zweryfikuj App Server.
3. Zapisz `docs/codex-integration.md`.
4. Przygotuj schemat danych i walidację Zod.
5. Zaimplementuj klienta App Servera.
6. Zaimplementuj normalizację limitów.
7. Zaimplementuj automatyczny wybór profilu.
8. Zaimplementuj czystą strategię Plus/Pro.
9. Zaimplementuj czystą strategię Business/Enterprise.
10. Zaimplementuj daty i workdays.
11. Zaimplementuj SQLite i migracje.
12. Zaimplementuj epoki.
13. Zaimplementuj reset detection.
14. Zaimplementuj cache.
15. Zaimplementuj CLI.
16. Zaimplementuj hook adapter.
17. Zaimplementuj install/uninstall hook.
18. Dodaj testy jednostkowe.
19. Dodaj testy integracyjne.
20. Dodaj kontrolę anonimizacji fixtures i dokumentacji.
21. Dodaj build Bun.
22. Dodaj GitHub Actions.
23. Uzupełnij README.
24. Uruchom formatter.
25. Uruchom lint.
26. Uruchom testy.
27. Zbuduj executable.
28. Uruchom smoke test.
29. Pokaż końcowe podsumowanie.

---

# 40. Kryteria akceptacji

Projekt jest gotowy, gdy:

## Wspólne

- globalny hook działa przed promptem;
- warning nie blokuje;
- block nie zamyka rozmowy;
- override’y resetują się po zmianie epoki;
- `unlock` zachowuje warningi;
- kilka sesji nie uszkadza stanu;
- dane są walidowane;
- cache ma kontrolę świeżości;
- aplikacja nie loguje promptów;
- executable nie wymaga Bun ani Node;
- fixtures i dokumentacja są zanonimizowane;
- testy przechodzą.

## Plus/Pro

- wykrywa tygodniowe okno;
- warning pojawia się od `ahead > 0`;
- block działa od 24h;
- `extend` dodaje 24h;
- dwa `extend` dają limit 72h;
- reset tygodniowego okna usuwa override’y;
- działa na macOS i Linuxie.

## Business/Enterprise

- odczytuje rzeczywiste `limit`, `used` i `resetsAt` lokalnie podczas działania;
- nie zapisuje rzeczywistych wartości do fixtures ani dokumentacji;
- nie liczy tokenów;
- nie potrzebuje admin API;
- rozkłada limit na poniedziałek–piątek;
- ignoruje święta;
- przyznaje cały budżet dnia na początku lokalnego dnia;
- weekend nie zwiększa budżetu;
- block działa od jednego dnia roboczego ahead;
- `extend` dodaje jeden dzień roboczy;
- limit zwiększony w trakcie okresu jest przeliczany proporcjonalnie;
- reset miesięcznego okresu usuwa override’y;
- działa na macOS arm64, macOS x64, Linux arm64 i Linux x64.

Nie publikuj aplikacji, paczki npm, Homebrew formula ani GitHub Release bez mojego wyraźnego polecenia.
