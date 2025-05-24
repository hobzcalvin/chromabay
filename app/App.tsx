/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import React, {useEffect, useState} from 'react';
import {
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  Platform,
  PermissionsAndroid,
  Alert,
} from 'react-native';
import {BleManager} from 'react-native-ble-plx';
import OtaHotUpdate from 'react-native-ota-hot-update';
import RNBlobUtil from 'react-native-blob-util';

const bleManager = new BleManager();

function App(): React.JSX.Element {
  const [isScanning, setIsScanning] = useState(false);
  const [devices, setDevices] = useState<any[]>([]);
  const [updateStatus, setUpdateStatus] = useState<string>('');

  useEffect(() => {
    // Initialize hot update
    const initHotUpdate = async () => {
      try {
        // Replace with your server URL or Git repository URL
        const serverUrl = 'https://your-server.com/updates';
        const currentVersion = await OtaHotUpdate.getCurrentVersion();
        
        // Download the bundle
        const downloadManager = RNBlobUtil.config({
          fileCache: true,
          appendExt: 'bundle',
        });
        
        await OtaHotUpdate.downloadBundleUri(
          downloadManager,
          serverUrl,
          currentVersion + 1,
          {
            progress: (received: string, total: string) => {
              const progress = (parseInt(received) / parseInt(total)) * 100;
              setUpdateStatus(`Downloading: ${progress.toFixed(1)}%`);
            },
          }
        );
        
        setUpdateStatus('Update downloaded');
        
        // Install the update
        const bundlePath = `${RNBlobUtil.fs.dirs.CacheDir}/bundle`;
        const success = await OtaHotUpdate.setupBundlePath(
          bundlePath,
          'bundle'
        );
        
        if (success) {
          setUpdateStatus('Update installed');
          await OtaHotUpdate.setCurrentVersion(currentVersion + 1);
          await OtaHotUpdate.resetApp();
        } else {
          setUpdateStatus('Update installation failed');
        }
      } catch (error) {
        console.error('Hot update error:', error);
        setUpdateStatus('Update failed');
      }
    };

    initHotUpdate();

    // Request necessary permissions
    const requestPermissions = async () => {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        );
        if (granted === PermissionsAndroid.RESULTS.GRANTED) {
          console.log('Location permission granted');
        }
      }
    };

    requestPermissions();

    // Start scanning for BLE devices
    const startScan = async () => {
      try {
        setIsScanning(true);
        bleManager.startDeviceScan(null, null, (error, device) => {
          if (error) {
            console.error(error);
            return;
          }
          if (device) {
            setDevices((prevDevices) => {
              const existingDevice = prevDevices.find((d) => d.id === device.id);
              if (!existingDevice) {
                return [...prevDevices, device];
              }
              return prevDevices;
            });
          }
        });
      } catch (error) {
        console.error('Error starting scan:', error);
      }
    };

    startScan();

    // Cleanup
    return () => {
      bleManager.stopDeviceScan();
      bleManager.destroy();
    };
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.content}>
        <Text style={styles.title}>BLE Device Scanner</Text>
        <Text style={styles.subtitle}>
          {isScanning ? 'Scanning...' : 'Not scanning'}
        </Text>
        <View style={styles.deviceList}>
          {devices.map((device) => (
            <Text key={device.id} style={styles.deviceItem}>
              {device.name || 'Unknown Device'} ({device.id})
            </Text>
          ))}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5',
  },
  content: {
    flex: 1,
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    marginBottom: 20,
  },
  deviceList: {
    flex: 1,
  },
  deviceItem: {
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#DDD',
  },
});

export default App;
