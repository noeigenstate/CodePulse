# ESP-IDF's early dependency pass does not evaluate our custom audio option.
# Register the driver dependency unconditionally; unused code is removed from legacy images.
idf_component_register(
    SRCS
        "app_main.c"
        "codepulse_audio.c"
        "audio_pin_policy.c"
        "aht20.c"
        "battery_adc.c"
        "board_safety.c"
        "buzzer.c"
        "codepulse_client.c"
        "codepulse_discovery.c"
        "codepulse_protocol.c"
        "codepulse_ui.c"
        "device_config.c"
        "device_identity.c"
        "display_sync_policy.c"
        "quiet_dashboard.c"
        "life_dashboard.c"
        "display_text.c"
        "epd_canvas.c"
        "epd_ssd1683.c"
        "usb_provisioning.c"
        "wifi_manager.c"
    INCLUDE_DIRS "."
    PRIV_REQUIRES
        esp_app_format
        esp_adc
        esp_driver_gpio
        esp_driver_i2c
        esp_driver_i2s
        esp_driver_ledc
        esp_driver_spi
        esp_driver_usb_serial_jtag
        esp_event
        esp_http_client
        esp_http_server
        esp_netif
        esp_rom
        esp_psram
        esp_system
        esp_timer
        esp_wifi
        nvs_flash
        spi_flash
        vfs
)

if(CODEPULSE_AUDIO_ENABLED)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE CODEPULSE_AUDIO_ENABLED=1)
    if(CODEPULSE_AUDIO_INPUT_ENABLED)
        target_compile_definitions(${COMPONENT_LIB} PRIVATE CODEPULSE_AUDIO_INPUT_ENABLED=1)
    endif()
    if(CODEPULSE_AUDIO_COMPILE_TEST)
        target_compile_definitions(${COMPONENT_LIB} PRIVATE CODEPULSE_AUDIO_COMPILE_TEST=1)
    endif()
    if(CODEPULSE_AUDIO_AMP_ACTIVE_HIGH)
        target_compile_definitions(${COMPONENT_LIB} PRIVATE CODEPULSE_AUDIO_AMP_ACTIVE_HIGH=1)
    else()
        target_compile_definitions(${COMPONENT_LIB} PRIVATE CODEPULSE_AUDIO_AMP_ACTIVE_HIGH=0)
    endif()
    foreach(pin BCLK WS DOUT AMP_EN MIC_CLK MIC_DATA TALK_BUTTON)
        if(NOT "${CODEPULSE_AUDIO_${pin}}" MATCHES "^-?[0-9]+$")
            message(FATAL_ERROR "Invalid audio GPIO ${pin}")
        endif()
        target_compile_definitions(${COMPONENT_LIB} PRIVATE CODEPULSE_AUDIO_${pin}=${CODEPULSE_AUDIO_${pin}})
    endforeach()
endif()

if(CODEPULSE_EPD_TEXT_TIMING_PROBE)
    target_sources(${COMPONENT_LIB} PRIVATE "../experiments/epd-text-timing-probe/timing_probe.c")
    target_include_directories(${COMPONENT_LIB} PRIVATE "../experiments/epd-text-timing-probe")
    target_compile_definitions(${COMPONENT_LIB} PRIVATE CODEPULSE_EPD_TEXT_TIMING_PROBE=1)
elseif(CODEPULSE_EPD_TEXT_PROBE)
    target_sources(${COMPONENT_LIB} PRIVATE "../experiments/epd-text-probe/text_probe.c")
    target_include_directories(${COMPONENT_LIB} PRIVATE
        "../experiments/epd-text-probe" "../experiments/epd-quiet-probe")
    target_compile_definitions(${COMPONENT_LIB} PRIVATE CODEPULSE_EPD_TEXT_PROBE=1)
elseif(CODEPULSE_EPD_QUIET_PROBE)
    target_sources(${COMPONENT_LIB} PRIVATE "../experiments/epd-quiet-probe/quiet_probe.c")
    target_include_directories(${COMPONENT_LIB} PRIVATE "../experiments/epd-quiet-probe")
    target_compile_definitions(${COMPONENT_LIB} PRIVATE CODEPULSE_EPD_QUIET_PROBE=1)
elseif(CODEPULSE_EPD_WAVEFORM_PROBE)
    target_sources(${COMPONENT_LIB} PRIVATE
        "../experiments/epd-waveform-probe/waveform_probe.c")
    target_include_directories(${COMPONENT_LIB} PRIVATE
        "../experiments/epd-waveform-probe")
    target_compile_definitions(${COMPONENT_LIB} PRIVATE CODEPULSE_EPD_WAVEFORM_PROBE=1)
elseif(CODEPULSE_EPD_WINDOW_PROBE)
    target_sources(${COMPONENT_LIB} PRIVATE
        "../experiments/epd-window-probe/window_probe.c")
    target_include_directories(${COMPONENT_LIB} PRIVATE
        "../experiments/epd-window-probe")
    target_compile_definitions(${COMPONENT_LIB} PRIVATE CODEPULSE_EPD_WINDOW_PROBE=1)
endif()
if(CODEPULSE_QUIET_PAIR150_TRIAL)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE CODEPULSE_QUIET_PAIR150_TRIAL=1)
endif()

if(CODEPULSE_QUIET_RECT_TRIAL)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE CODEPULSE_QUIET_RECT_TRIAL=1)
endif()
