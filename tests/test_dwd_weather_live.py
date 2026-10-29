import io
import unittest
import zipfile
from datetime import datetime, timezone

from src.dwd_weather import DwdSourceError
from src.dwd_weather_live import build_snapshot, local_iso, parse_cdc_product, parse_mosmix_kmz, weather_symbol
from src.validate_dwd_weather_schema import validate


def cdc_zip(text: str, name: str = "sample.txt") -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(name, text)
    return out.getvalue()


def mosmix_kmz(*, issue="2026-10-18T15:00:00Z", times=None, values=None) -> bytes:
    times = times or ["2026-10-18T17:00:00Z", "2026-10-18T18:00:00Z"]
    values = values or {
        "TTT": "285.15 284.15", "FF": "2.00 3.00", "DD": "270 280",
        "FX1": "4.00 5.00", "RR1c": "0.0 1.2", "PPPP": "101325 101200", "ww": "3 61",
    }
    steps = "".join(f"<d:TimeStep>{t}</d:TimeStep>" for t in times)
    forecasts = "".join(f'<d:Forecast x:elementName="{key}"><d:value>{value}</d:value></d:Forecast>' for key, value in values.items())
    xml = f'''<k:kml xmlns:k="http://www.opengis.net/kml/2.2"
      xmlns:d="http://www.opengis.net/kml/2.2" xmlns:x="https://opendata.dwd.de/weather/lib/pointforecast_dwd_extension_V1_0.xsd">
      <k:Document><d:IssueTime>{issue}</d:IssueTime>
      <d:Model x:name="ICON" x:referenceTime="2026-10-18T12:00:00Z"/>
      <d:ForecastTimeSteps>{steps}</d:ForecastTimeSteps>
      <k:Placemark><k:name>P0043</k:name><k:description>SENFTENBERG/LUB</k:description>
      <k:Point><k:coordinates>14.0,51.52,103</k:coordinates></k:Point>
      <k:ExtendedData>{forecasts}</k:ExtendedData></k:Placemark></k:Document></k:kml>'''.encode()
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("sample.kml", xml)
    return out.getvalue()


class DwdLiveWeatherTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 18, 17, 52, tzinfo=timezone.utc)

    def test_temperature_humidity_uses_latest_valid_row_and_keeps_fields_separate(self):
        data = cdc_zip("MESS_DATUM;QN;PP_10;TT_10;RF_10;TD_10;eor\n"
                       "202610181650;2;-999;9.4;94.3;8.5;eor\n"
                       "202610181720;2;-999;9.6;95.6;8.9;eor\n")
        result = parse_cdc_product(data, self.now, key="temperatureHumidity")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["measuredAt"], "2026-10-18T17:20:00Z")
        self.assertEqual(result["measuredAtLocal"], "2026-10-18T19:20:00+02:00")
        self.assertEqual(result["values"]["temperatureC"], 9.6)
        self.assertEqual(result["values"]["relativeHumidityPercent"], 95.6)
        self.assertEqual(result["ageMinutes"], 32.0)

    def test_pressure_uses_separately_configured_station(self):
        data = cdc_zip("MESS_DATUM;QN;PP_10;TT_10;RF_10;TD_10;eor\n202610181720;2;1016.7;9;95;8;eor\n")
        result = parse_cdc_product(data, self.now, key="stationPressure")
        self.assertEqual(result["station"]["id"], "01001")
        self.assertEqual(result["values"]["stationPressureHpa"], 1016.7)

    def test_wind_and_gust_convert_meters_per_second_to_kmh(self):
        wind = parse_cdc_product(cdc_zip("MESS_DATUM;QN;FF_10;DD_10;eor\n202610181720;2;1.0;360;eor\n"), self.now, key="wind")
        gust = parse_cdc_product(cdc_zip("MESS_DATUM;QN;FX_10;FNX_10;FMX_10;DX_10;eor\n202610181720;2;1.5;0.7;1.3;350;eor\n"), self.now, key="windGust")
        self.assertEqual(wind["values"], {"windSpeedKmh": 3.6, "windDirectionDeg": 0.0})
        self.assertEqual(gust["values"]["windGustKmh"], 5.4)

    def test_precipitation_is_previous_ten_minutes_and_sentinel_remains_missing(self):
        result = parse_cdc_product(cdc_zip("MESS_DATUM;QN;RWS_DAU_10;RWS_10;RWS_IND_10;eor\n202610181720;2;-999;0.00;-999;eor\n"), self.now, key="precipitation")
        self.assertEqual(result["values"]["precipitation10MinMm"], 0.0)
        self.assertEqual(result["status"], "ok")

    def test_stale_product_is_separately_marked(self):
        then = datetime(2026, 10, 18, 16, 40, tzinfo=timezone.utc)
        result = parse_cdc_product(cdc_zip("MESS_DATUM;QN;RWS_10;eor\n202610181640;2;0.00;eor\n"), self.now, key="precipitation")
        self.assertEqual(result["status"], "stale")
        self.assertEqual(result["ageMinutes"], 72.0)

    def test_mosmix_is_parsed_with_utc_times_and_unit_conversions(self):
        result = parse_mosmix_kmz(mosmix_kmz(), self.now)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["stationId"], "P0043")
        self.assertEqual(result["coordinates"], {"latitude": 51.52, "longitude": 14.0})
        self.assertEqual(result["issuedAt"], "2026-10-18T15:00:00Z")
        self.assertEqual(result["points"][0]["validAt"], "2026-10-18T17:00:00Z")
        self.assertEqual(result["points"][0]["validAtLocal"], "2026-10-18T19:00:00+02:00")
        self.assertEqual(result["points"][0]["values"]["temperatureC"], 12.0)
        self.assertEqual(result["points"][0]["values"]["windSpeedKmh"], 7.2)
        self.assertEqual(result["points"][0]["values"]["pressureHpa"], 1013.25)

    def test_mosmix_rejects_dtd_malformed_and_overaged_runs(self):
        payload = mosmix_kmz()
        with zipfile.ZipFile(io.BytesIO(payload)) as z:
            xml = z.read("sample.kml").replace(b"<k:kml", b"<!DOCTYPE x [<!ENTITY e SYSTEM 'file:///etc/passwd'>]><k:kml", 1)
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w") as z:
            z.writestr("sample.kml", xml)
        with self.assertRaises(DwdSourceError):
            parse_mosmix_kmz(out.getvalue(), self.now)
        with self.assertRaises(DwdSourceError):
            parse_mosmix_kmz(b"bad zip", self.now)
        broken = io.BytesIO()
        with zipfile.ZipFile(broken, "w") as z:
            z.writestr("broken.kml", b"<kml><broken>")
        with self.assertRaises(DwdSourceError):
            parse_mosmix_kmz(broken.getvalue(), self.now)
        old = parse_mosmix_kmz(mosmix_kmz(issue="2026-10-17T00:00:00Z"), self.now)
        self.assertEqual(old["status"], "stale")

    def test_berlin_local_time_distinguishes_cet_and_cest(self):
        winter = local_iso(datetime(2026, 1, 15, 12, tzinfo=timezone.utc))
        summer = local_iso(datetime(2026, 7, 15, 12, tzinfo=timezone.utc))
        self.assertEqual(winter, "2026-01-15T13:00:00+01:00")
        self.assertEqual(summer, "2026-07-15T14:00:00+02:00")

    def test_mosmix_weather_code_keeps_numeric_code_and_adds_documented_symbol(self):
        result = parse_mosmix_kmz(mosmix_kmz(values={"ww": "61 95"}), self.now)
        self.assertEqual(result["points"][0]["values"]["weatherCode"], 61)
        self.assertEqual(result["points"][0]["values"]["weatherSymbol"], "rain")
        self.assertEqual(result["points"][1]["values"]["weatherCode"], 95)
        self.assertEqual(result["points"][1]["values"]["weatherSymbol"], "thunderstorm")

    def test_unknown_weather_code_gets_neutral_symbol_and_missing_code_stays_missing(self):
        result = parse_mosmix_kmz(mosmix_kmz(values={"ww": "123 -"}), self.now)
        self.assertEqual(result["points"][0]["values"]["weatherSymbol"], "unknown")
        self.assertNotIn("weatherCode", result["points"][1]["values"])
        self.assertNotIn("weatherSymbol", result["points"][1]["values"])

    def test_weather_symbol_groups_are_bounded_and_invalid_codes_are_neutral(self):
        self.assertEqual(weather_symbol(45), "fog")
        self.assertEqual(weather_symbol(67), "freezing_rain")
        self.assertEqual(weather_symbol(86), "snow_showers")
        self.assertEqual(weather_symbol(-1), "unknown")
        self.assertEqual(weather_symbol(61.5), "unknown")

    def test_partial_source_failure_preserves_other_products_and_error_metadata(self):
        good = cdc_zip("MESS_DATUM;QN;RWS_10;eor\n202610181720;2;0.00;eor\n")
        payloads = {key: RuntimeError("offline") for key in ("temperatureHumidity", "stationPressure", "wind", "windGust")}
        payloads["precipitation"] = good
        snapshot = build_snapshot(self.now, payloads, mosmix_kmz())
        self.assertEqual(snapshot["status"], "partial")
        self.assertEqual(snapshot["observations"]["precipitation"]["status"], "ok")
        failed = snapshot["observations"]["wind"]
        self.assertEqual(failed["status"], "error")
        self.assertEqual(failed["units"]["windSpeedKmh"], "km/h")
        self.assertEqual(failed["source"]["license"], "CC BY 4.0")

    def test_missing_mosmix_parameter_is_not_filled(self):
        result = parse_mosmix_kmz(mosmix_kmz(values={"TTT": "- -"}), self.now)
        self.assertNotIn("windSpeedKmh", result["points"][0]["values"])

    def test_snapshot_and_neutral_weather_symbol_conform_to_v2_schema(self):
        from pathlib import Path
        import json
        schema = json.loads(Path("docs/dwd-weather-v2.schema.json").read_text(encoding="utf-8"))
        good = cdc_zip("MESS_DATUM;QN;RWS_10;eor\n202610181720;2;0.00;eor\n")
        payloads = {key: RuntimeError("offline") for key in ("temperatureHumidity", "stationPressure", "wind", "windGust")}
        payloads["precipitation"] = good
        snapshot = build_snapshot(self.now, payloads, mosmix_kmz(values={"ww": "19 61"}))
        self.assertEqual(validate(snapshot, schema), [])
        snapshot["forecast"]["points"][0]["values"]["weatherSymbol"] = "made_up"
        self.assertTrue(validate(snapshot, schema))

    def test_source_failures_remain_separate_in_snapshot(self):
        good = cdc_zip("MESS_DATUM;QN;RWS_10;eor\n202610181720;2;0.00;eor\n")
        payloads = {"temperatureHumidity": RuntimeError("offline"), "stationPressure": RuntimeError("offline"), "wind": RuntimeError("offline"),
                    "windGust": RuntimeError("offline"), "precipitation": good}
        snapshot = build_snapshot(self.now, payloads, RuntimeError("MOSMIX offline"))
        self.assertEqual(snapshot["status"], "partial")
        self.assertEqual(snapshot["observations"]["precipitation"]["status"], "ok")
        self.assertEqual(snapshot["observations"]["wind"]["status"], "error")
        self.assertEqual(snapshot["forecast"]["status"], "error")


if __name__ == "__main__":
    unittest.main()
