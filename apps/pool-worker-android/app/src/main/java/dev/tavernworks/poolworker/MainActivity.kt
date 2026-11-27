package dev.tavernworks.poolworker

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlin.math.roundToInt

private val Amber = Color(0xFFE8B04A)
private val Parchment = Color(0xFFF3E3C0)
private val Wood = Color(0xFF2A1E14)
private val Night = Color(0xFF17120D)
private val Green = Color(0xFF7BC47F)
private val Red = Color(0xFFE07A5F)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Android stopped the service (or the phone rebooted the app) while the owner wanted it on.
        val cfg = Config(this)
        if (cfg.wantRunning && !WorkerState.ui.value.serviceRunning) PoolWorkerService.start(this)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(
                primary = Amber, onPrimary = Night, surface = Wood, onSurface = Parchment,
                background = Night, onBackground = Parchment, secondary = Parchment)) {
                Box(Modifier.fillMaxSize().background(Night).systemBarsPadding(), contentAlignment = Alignment.TopCenter) {
                    Screen()
                }
            }
        }
    }
}

@Composable
private fun Screen() {
    val ctx = LocalContext.current
    val cfg = remember { Config(ctx) }
    val ui by WorkerState.ui.collectAsStateWithLifecycle()
    val renderer = remember { DeviceInfo.gpuRenderer(cfg) }
    val ramMb = remember { DeviceInfo.totalRamMb(ctx) }
    val gpuCapable = DeviceInfo.adrenoGen(renderer) >= 7
    var showSettings by remember { mutableStateOf(false) }
    var showLog by remember { mutableStateOf(false) }
    var batteryOk by remember { mutableStateOf(ignoringBatteryOptimizations(ctx)) }

    val notifPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        PoolWorkerService.start(ctx)
    }
    val join = {
        if (Build.VERSION.SDK_INT >= 33) notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        else PoolWorkerService.start(ctx)
    }

    Column(
        Modifier.widthIn(max = 560.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Column {
            Text("AI Pool worker", fontSize = 26.sp, fontWeight = FontWeight.Bold, color = Amber)
            Text(DeviceInfo.model(), color = Parchment.copy(alpha = 0.7f))
        }

        // ---- status
        Card(colors = CardDefaults.cardColors(containerColor = Wood), shape = RoundedCornerShape(14.dp)) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(12.dp).background(phaseColor(ui.phase), CircleShape))
                    Spacer(Modifier.size(10.dp))
                    Text(ui.phase.label + if (ui.phase == Phase.Serving && ui.streams > 0) " · working" else "",
                        fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = Parchment)
                }
                if (ui.detail.isNotEmpty()) Text(ui.detail, color = Parchment.copy(alpha = 0.85f))
                if (ui.pinWarning.isNotEmpty()) Text(ui.pinWarning, color = Red)
                HorizontalDivider(color = Parchment.copy(alpha = 0.15f))
                Fact("GPU", DeviceInfo.gpuShortName(renderer) +
                        if (gpuCapable) " (can compute)" else " (lends CPU + RAM)")
                Fact("Serving on", ui.servingOn.ifEmpty { "not running" })
                Fact("Memory lent", Worker.gb(cfg.offeredMb.takeIf { it >= 512 } ?: DeviceInfo.autoOfferedMb(ramMb)) +
                        " of " + Worker.gb(ramMb.toInt()))
                Fact("Approved", if (ui.approved) "yes" else if (cfg.enrolled) "not yet" else "not enrolled")
                Fact("Relay", if (ui.relayConnected) "connected" else "not connected")
                Fact("Splits now", ui.streams.toString())
                Fact("Heat", ui.heat.ifEmpty {
                    "battery %.1f °C · Android: %s".format(DeviceInfo.battery(ctx).tempC,
                        DeviceInfo.thermalName(DeviceInfo.thermalStatus(ctx)))
                })
                if (ui.poolModel.isNotEmpty()) Fact("Pool model", ui.poolModel)
                Fact("Engine", "llama.cpp " + BuildConfig.ENGINE_PIN)
            }
        }

        // ---- the one button
        if (!ui.serviceRunning) {
            Button(onClick = join, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Amber, contentColor = Night)) {
                Text("Join the pool", fontSize = 18.sp, fontWeight = FontWeight.Bold)
            }
        } else {
            OutlinedButton(onClick = { PoolWorkerService.stop(ctx) },
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                Text("Leave the pool", fontSize = 18.sp, color = Parchment)
            }
        }

        if (!batteryOk) {
            Card(colors = CardDefaults.cardColors(containerColor = Wood)) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Android may pause the worker when the screen is off. Let it run in the background so it stays in the pool.",
                        color = Parchment)
                    OutlinedButton(onClick = {
                        askIgnoreBatteryOptimizations(ctx)
                        batteryOk = ignoringBatteryOptimizations(ctx)
                    }, modifier = Modifier.fillMaxWidth()) { Text("Let it run in the background", color = Amber) }
                }
            }
        }

        if (ui.approved && cfg.enrolled) {
            OutlinedButton(onClick = {
                val link = cfg.poolUrl + "/chat#link=" + cfg.enrollmentId + "." + cfg.key
                ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link)))
            }, modifier = Modifier.fillMaxWidth()) { Text("Link this phone to my pool account", color = Amber) }
        }

        // ---- settings
        TextButton(onClick = { showSettings = !showSettings }) {
            Text(if (showSettings) "Hide settings" else "Settings", color = Amber)
        }
        if (showSettings) SettingsCard(cfg, ramMb, gpuCapable, locked = ui.serviceRunning)

        TextButton(onClick = { showLog = !showLog }) {
            Text(if (showLog) "Hide log" else "Show log", color = Amber)
        }
        if (showLog) {
            Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF0F0C09))) {
                Text(ui.log.takeLast(60).joinToString("\n").ifEmpty { "Nothing yet." },
                    Modifier.padding(12.dp), fontFamily = FontFamily.Monospace, fontSize = 11.sp,
                    color = Parchment.copy(alpha = 0.85f))
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun SettingsCard(cfg: Config, ramMb: Long, gpuCapable: Boolean, locked: Boolean) {
    var url by remember { mutableStateOf(cfg.poolUrl) }
    var name by remember { mutableStateOf(cfg.name.ifEmpty { DeviceInfo.defaultName() }) }
    val maxMb = ((ramMb * 0.6).toLong() / 512 * 512).coerceAtLeast(2048)
    var mb by remember { mutableFloatStateOf((cfg.offeredMb.takeIf { it >= 512 } ?: DeviceInfo.autoOfferedMb(ramMb)).toFloat()) }
    var charging by remember { mutableStateOf(cfg.onlyWhileCharging) }
    var useGpu by remember { mutableStateOf(cfg.backend != "cpu") }
    var note by remember { mutableStateOf("") }
    var heat by remember { mutableStateOf(cfg.heatMode) }

    Card(colors = CardDefaults.cardColors(containerColor = Wood)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            // Heat pause applies at once, even while in the pool.
            Text("Heat pause", color = Parchment, fontWeight = FontWeight.SemiBold)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                for (m in HeatMode.entries) {
                    val picked = m == heat
                    val onPick = { heat = m; cfg.heatMode = m; WorkerState.log("heat pause set to ${m.label}") }
                    if (picked) Button(onClick = onPick, modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.buttonColors(containerColor = Amber, contentColor = Night)) { Text(m.label) }
                    else OutlinedButton(onClick = onPick, modifier = Modifier.weight(1f)) { Text(m.label, color = Parchment) }
                }
            }
            Text(heat.blurb, color = Parchment.copy(alpha = 0.75f), fontSize = 13.sp)
            HorizontalDivider(color = Parchment.copy(alpha = 0.15f))
            if (locked) Text("Leave the pool to change the rest.", color = Parchment.copy(alpha = 0.7f))
            OutlinedTextField(url, { url = it }, label = { Text("Pool address") }, singleLine = true,
                enabled = !locked, modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
            OutlinedTextField(name, { name = it.take(60) }, label = { Text("This phone's name in the pool") },
                singleLine = true, enabled = !locked, modifier = Modifier.fillMaxWidth())
            Text("Memory to lend: " + Worker.gb(mb.roundToInt()), color = Parchment)
            Slider(value = mb, onValueChange = { mb = (it / 512).roundToInt() * 512f },
                valueRange = 1024f..maxMb.toFloat(), enabled = !locked)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Only while charging", Modifier.weight(1f), color = Parchment)
                Switch(charging, { charging = it }, enabled = !locked)
            }
            if (gpuCapable) Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Use the Adreno GPU when the model allows", Modifier.weight(1f), color = Parchment)
                Switch(useGpu, { useGpu = it }, enabled = !locked)
            }
            Button(enabled = !locked, onClick = {
                val reEnroll = cfg.enrolled && (name.trim() != cfg.name || mb.roundToInt() != cfg.offeredMb ||
                        url.trim().trimEnd('/') != cfg.poolUrl)
                cfg.poolUrl = url.ifBlank { Config.DEFAULT_POOL }
                cfg.name = name.ifBlank { DeviceInfo.defaultName() }
                cfg.offeredMb = mb.roundToInt()
                cfg.onlyWhileCharging = charging
                cfg.backend = if (useGpu) "auto" else "cpu"
                if (useGpu) cfg.gpuFailed = false
                if (reEnroll) {
                    cfg.forgetEnrollment()
                    WorkerState.set { it.copy(enrolled = false, approved = false) }
                }
                note = if (reEnroll) "Saved. The pool sees this phone as a new machine now, so approve it again after you join."
                       else "Saved."
            }, colors = ButtonDefaults.buttonColors(containerColor = Amber, contentColor = Night)) { Text("Save") }
            if (note.isNotEmpty()) Text(note, color = Parchment.copy(alpha = 0.85f))
        }
    }
}

@Composable
private fun Fact(label: String, value: String) {
    Row(Modifier.fillMaxWidth()) {
        Text(label, Modifier.weight(0.4f), color = Parchment.copy(alpha = 0.6f))
        Text(value, Modifier.weight(0.6f), color = Parchment)
    }
}

private fun phaseColor(p: Phase): Color = when (p) {
    Phase.Serving -> Green
    Phase.Error -> Red
    Phase.Idle -> Parchment.copy(alpha = 0.4f)
    else -> Amber
}

private fun ignoringBatteryOptimizations(ctx: android.content.Context): Boolean =
    ctx.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(ctx.packageName)

@SuppressLint("BatteryLife")
private fun askIgnoreBatteryOptimizations(ctx: android.content.Context) {
    runCatching {
        ctx.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + ctx.packageName)))
    }.onFailure {
        ctx.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
    }
}
